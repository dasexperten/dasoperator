import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { syncWbSalesToErp } from '../../_marketplace/erp-sales-sync.mjs';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
}

// Owner 2026-10-12: backup run at 07:00 Yerevan (03:00 UTC). It works only when the
// 05:00 run did not finish today; otherwise it records a skip and touches nothing.
const BACKUP_CRON = '0 3 * * *';

export default erpWorker<Env>('erp-wb-sales', async (env, dry, cron) => {
  if (dry) return { note: 'dry · sync skipped' };
  if (cron === BACKUP_CRON) {
    const today = new Date().toISOString().slice(0, 10);
    const done = await env.DB.prepare(
      "SELECT 1 FROM erp_cron_runs WHERE worker = 'erp-wb-sales' AND ok = 1 AND rows > 0 AND substr(started_at, 1, 10) = ? LIMIT 1",
    ).bind(today).first();
    if (done) return { rows: 0, note: 'backup skipped · 05:00 run already succeeded today' };
  }
  const r = await syncWbSalesToErp(env);
  if (r?.error) throw new Error(String(r.error));
  // An ad-read failure leads the note so the run log shows it before the long detail.
  const ads = (r?.advertising_error ? `ADS UNKNOWN: ${r.advertising_error} | ` : '')
    + (r?.library_error ? `LIBRARY NOT WRITTEN: ${r.library_error} | ` : '');
  return { rows: r?.rows_synced ?? 0, note: (ads + JSON.stringify(r)).slice(0, 1000) };
});
