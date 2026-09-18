// =============================================================================
// /api/cron-runs — the erp-* timer workers' run log (table erp_cron_runs)
//   GET /  — last run per worker + failures in the last 24 h + the 50 newest runs
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';

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

export default route;
