import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { syncWbSalesToErp } from '../../_marketplace/erp-sales-sync.mjs';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
}

export default erpWorker<Env>('erp-wb-sales', async (env, dry) => {
  if (dry) return { note: 'dry · sync skipped' };
  const r = await syncWbSalesToErp(env);
  if (r?.error) throw new Error(String(r.error));
  // An ad-read failure leads the note so the run log shows it before the long detail.
  const ads = (r?.advertising_error ? `ADS UNKNOWN: ${r.advertising_error} | ` : '')
    + (r?.library_error ? `LIBRARY NOT WRITTEN: ${r.library_error} | ` : '');
  return { rows: r?.rows_synced ?? 0, note: (ads + JSON.stringify(r)).slice(0, 1000) };
});
