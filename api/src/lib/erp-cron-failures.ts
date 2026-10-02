// Failed erp-* timer runs reach Telegram once, through the ERP's one alert path.
import type { Env } from '../types';
import { reportCronFailure } from './auto-healer';

export async function notifyErpCronFailures(env: Env): Promise<number> {
  // A run with no end after 20 minutes was cut off (timer runs get 15): close it as a failure.
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  await env.DB.prepare(
    `UPDATE erp_cron_runs SET finished_at = ?, ok = 0, error = 'cut off before it finished'
      WHERE finished_at IS NULL AND started_at < ?`,
  ).bind(new Date().toISOString(), cutoff).run();

  // Owner 2026-10-02 (via Mina): a cut-off is Cloudflare dropping one run, not a broken job.
  // If the same timer already ran fine after it, nothing was lost — close it quietly.
  // A cut-off with no clean run after it still reaches Telegram, as does every real error.
  await env.DB.prepare(
    `UPDATE erp_cron_runs SET notified = 1, note = 'cut-off recovered: a later run of this timer succeeded; not reported'
      WHERE ok = 0 AND notified = 0 AND error = 'cut off before it finished'
        AND EXISTS (SELECT 1 FROM erp_cron_runs later
                     WHERE later.worker = erp_cron_runs.worker AND later.id > erp_cron_runs.id AND later.ok = 1)`,
  ).run();

  const { results } = await env.DB.prepare(
    `SELECT id, worker, cron, error FROM erp_cron_runs
      WHERE ok = 0 AND finished_at IS NOT NULL AND notified = 0
      ORDER BY id LIMIT 20`,
  ).all<{ id: number; worker: string; cron: string; error: string | null }>();

  for (const r of results) {
    await env.DB.prepare('UPDATE erp_cron_runs SET notified = 1 WHERE id = ?').bind(r.id).run();
    await reportCronFailure(env, r.worker, r.error ?? 'failed without a message', { cron: r.cron });
  }
  return results.length;
}
