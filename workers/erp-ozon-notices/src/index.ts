import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runOzonNotices } from '../../_marketplace/seat-reports.mjs';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
  ORG_DB: D1Database;
  BOARD: Fetcher;
}

// The board cell's hour is the timer's hour; a manual run takes the morning cell.
function cellHour(cron: string): number {
  const h = Number(cron.trim().split(/\s+/)[1]);
  return Number.isFinite(h) ? h : 4;
}

export default erpWorker<Env>('erp-ozon-notices', async (env, dry, cron) => {
  if (dry) return { note: `dry · ${cron} · board cell not written` };
  // The seat code reads the board database as env.DB.
  const seat = { ...env, DB: env.ORG_DB };
  const r = await runOzonNotices(seat, { hour: cellHour(cron) });
  if (r && r.ok === false) throw new Error(String(r.error ?? 'failed'));
  return { note: String(r?.line ?? JSON.stringify(r)).slice(0, 600) };
});
