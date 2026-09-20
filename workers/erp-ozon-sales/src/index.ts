import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { syncOzonSalesToErp } from '../../_marketplace/erp-sales-sync.mjs';
import { syncOzonFboSalesOnly } from '../../../api/src/marketplaces/fbo-sync';

interface Env extends BaseEnv {
  ERP_DB: D1Database;
}

export default erpWorker<Env>('erp-ozon-sales', async (env, dry) => {
  if (dry) return { note: 'dry · sync skipped' };
  const r = await syncOzonSalesToErp(env);
  if (r?.error) throw new Error(String(r.error));
  const fbo = await syncOzonFboSalesOnly(env);
  return {
    rows: (r?.rows_synced ?? 0) + fbo.sales,
    note: JSON.stringify({ sales: r, fbo }).slice(0, 500),
  };
});
