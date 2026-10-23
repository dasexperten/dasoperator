// Failures are journalled once; only persistent unresolved episodes reach Telegram.
import type { Env } from '../types';
import { reportCronFailure } from './auto-healer';

export async function notifyErpCronFailures(env: Env): Promise<number> {
  // No terminal receipt after 20 minutes (timer runs get 15): completion is unconfirmed.
  // This does not prove that an external action failed or is safe to repeat.
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  await env.DB.prepare(
    `UPDATE erp_cron_runs SET finished_at = ?, ok = 0, error = 'completion unconfirmed after 20 minutes'
      WHERE finished_at IS NULL AND started_at < ?`,
  ).bind(new Date().toISOString(), cutoff).run();

  // Owner 2026-10-02 (via Mina): a cut-off is Cloudflare dropping one run, not a broken job.
  // A later completed work pass recovers lane health; it does not prove the old invocation completed.
  // Owner 2026-10-03: all recovered failures stay quiet, not just cut-offs.
  await env.DB.prepare(
    `UPDATE erp_cron_runs SET notified = 1, note = COALESCE(note, '') || ' recovered: a later run succeeded; not reported'
      WHERE ok = 0 AND notified = 0 AND finished_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM erp_cron_runs later
                     WHERE later.worker = erp_cron_runs.worker AND later.id > erp_cron_runs.id AND later.ok = 1
                       AND later.finished_at IS NOT NULL
                       -- Owner 2026-10-21: a tick that only said not due or taken did no work and proves nothing.
                       AND COALESCE(later.note, '') NOT LIKE '%: not due%' AND COALESCE(later.note, '') NOT LIKE '%: taken by another run%')`,
  ).run();

  const { results } = await env.DB.prepare(
    `SELECT id, worker, cron, error, started_at FROM erp_cron_runs
      WHERE ok = 0 AND finished_at IS NOT NULL AND notified = 0
      ORDER BY id LIMIT 20`,
  ).all<{ id: number; worker: string; cron: string; error: string | null; started_at: string }>();

  for (const r of results) {
    await env.DB.prepare('UPDATE erp_cron_runs SET notified = 1 WHERE id = ?').bind(r.id).run();
    await reportCronFailure(env, r.worker, r.error ?? 'failed without a message', { cron: r.cron, occurredAt: Math.floor(Date.parse(r.started_at) / 1000) });
  }
  return results.length;
}
