import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { syncOzonStocksToSite } from '../../_site/site-stock-sync.mjs';

export default erpWorker<BaseEnv>('erp-site-stock', async (env, dry) => {
  if (dry) return { note: 'dry · storefront not called' };
  const r = await syncOzonStocksToSite(env);
  if (!r || r.ok === false) throw new Error(String(r?.error ?? 'no result'));
  return { note: JSON.stringify(r).slice(0, 600) };
});
