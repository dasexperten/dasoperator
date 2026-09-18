// =============================================================================
// /api/cron-runs — the erp-* timer workers' run log (table erp_cron_runs)
//   GET /       — last run per worker + failures in the last 24 h + the 50 newest runs
//   GET /guard  — Viktor's ERP guard: expected vs actual timer runs per worker
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { expectedFires } from '../lib/cron-expect';
import SCHEDULES from '../generated/erp-schedules.json';

const route = new Hono<{ Bindings: Env }>();

route.get('/', async (c) => {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [latest, fails, recent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.* FROM erp_cron_runs r
         JOIN (SELECT worker, MAX(id) AS mid FROM erp_cron_runs GROUP BY worker) m ON r.id = m.mid
        ORDER BY r.worker`,
    ).all(),
    c.env.DB.prepare(
      `SELECT worker, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_24h,
              SUM(CASE WHEN ok = 0 AND finished_at IS NOT NULL THEN 1 ELSE 0 END) AS failed_24h
         FROM erp_cron_runs WHERE started_at >= ? GROUP BY worker`,
    ).bind(since).all(),
    c.env.DB.prepare('SELECT * FROM erp_cron_runs ORDER BY id DESC LIMIT 50').all(),
  ]);
  return c.json({
    success: true,
    result: { workers: latest.results, last_24h: fails.results, recent: recent.results },
  });
});

// Viktor Palich is the ERP guard (Owner 2026-09-18). For each erp-* worker over the window:
// timer fires expected (from its wrangler.toml, api/src/generated/erp-schedules.json)
// against runs logged. A worker born inside the window is judged from its first run.
type Verdict = 'green' | 'yellow' | 'red' | 'quiet';

route.get('/guard', async (c) => {
  const hours = Math.min(Math.max(Number(c.req.query('hours') ?? 24), 1), 168);
  const to = new Date(Date.now() - 20 * 60_000); // runs need time to finish
  const from = new Date(to.getTime() - hours * 3600_000);
  const { results } = await c.env.DB.prepare(
    `SELECT worker, cron, started_at, finished_at, ok, dry_run, error FROM erp_cron_runs
      WHERE started_at >= ? ORDER BY id`,
  ).bind(new Date(from.getTime() - 7 * 86400_000).toISOString()).all<{
    worker: string; cron: string; started_at: string; finished_at: string | null; ok: number; dry_run: number; error: string | null;
  }>();
  const born = new Map<string, string>();
  const lastOk = new Map<string, string>();
  for (const r of results) {
    if (!born.has(r.worker)) born.set(r.worker, r.started_at);
    if (r.ok && !r.dry_run) lastOk.set(r.worker, r.started_at);
  }
  const firstEver = await c.env.DB.prepare('SELECT worker, MIN(started_at) AS first FROM erp_cron_runs GROUP BY worker')
    .all<{ worker: string; first: string }>();
  for (const r of firstEver.results) born.set(r.worker, r.first);

  const workers = Object.entries(SCHEDULES as Record<string, string[]>).map(([worker, crons]) => {
    const start = born.has(worker) ? new Date(Math.max(from.getTime(), Date.parse(born.get(worker)!))) : from;
    const expected = crons.reduce((n, cr) => n + expectedFires(cr, start, to).length, 0);
    const rows = results.filter((r) => r.worker === worker && r.cron !== 'manual' && r.started_at >= start.toISOString() && r.started_at < to.toISOString());
    const ran = rows.length;
    const ok = rows.filter((r) => r.ok && !r.dry_run).length;
    const dry = rows.filter((r) => r.dry_run).length;
    const failed = rows.filter((r) => !r.ok && r.finished_at).length;
    const missed = Math.max(0, expected - ran);
    const lastError = [...rows].reverse().find((r) => !r.ok && r.finished_at)?.error ?? null;
    let verdict: Verdict = 'green';
    if (!born.has(worker)) verdict = expected > 0 ? 'red' : 'quiet';
    else if (failed > 0 || (expected > 0 && ok === 0 && dry === 0)) verdict = 'red';
    else if (missed > Math.max(1, Math.floor(expected * 0.05))) verdict = 'red';
    else if (dry > 0 || missed > 0) verdict = 'yellow';
    else if (expected === 0) verdict = 'quiet';
    return { worker, crons, expected, ran, ok, failed, dry, missed, last_ok: lastOk.get(worker) ?? null, last_error: lastError, verdict };
  });
  const count = (v: Verdict) => workers.filter((w) => w.verdict === v).length;
  return c.json({
    success: true,
    result: {
      window: { from: from.toISOString(), to: to.toISOString(), hours },
      totals: { workers: workers.length, green: count('green'), yellow: count('yellow'), red: count('red'), quiet: count('quiet') },
      workers,
    },
  });
});

export default route;
