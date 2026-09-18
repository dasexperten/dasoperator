import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { syncOzonStocksToErp } from '../../_marketplace/erp-stocks-sync.mjs';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
}

export default erpWorker<Env>('erp-ozon-stocks', async (env, dry) => {
  if (dry) return { note: 'dry · sync skipped' };
  const r = await syncOzonStocksToErp(env);
  if (r?.error) throw new Error(String(r.error));
  return { rows: r?.rows_synced ?? 0, note: JSON.stringify(r).slice(0, 500) };
});
