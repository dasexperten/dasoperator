import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runCheck } from '../../_promozon/promozon.mjs';

interface Env extends BaseEnv {
  PROMO_DB: D1Database;
}

export default erpWorker<Env>('erp-promozon', async (env, dry) => {
  if (dry) return { note: 'dry · promozon not started' };
  // The promozon code reads its own database as env.DB.
  const r = await runCheck({ ...env, DB: env.PROMO_DB }, 'cron');
  if (r && (r.status === 'error' || r.error)) throw new Error(String(r.error ?? 'promozon error'));
  return { rows: r?.products_checked ?? r?.productsChecked, note: JSON.stringify(r).slice(0, 600) };
});
