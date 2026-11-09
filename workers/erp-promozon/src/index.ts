import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runPromotionMonitor } from '../../_promozon/monitor';

interface Env extends BaseEnv {
  PROMO_DB: D1Database;
  OZON_SELLER_API_KEY?: string;
  OZON_SELLER_CLIENT_ID?: string;
}

export default erpWorker<Env>('erp-promozon', async (env, dry) => {
  if (dry) return { note: 'dry · read-only promotion monitor not started' };
  const r = await runPromotionMonitor(env);
  if (!r.sales_available) throw new Error(`Ozon monitor saved partial report: ${r.sales_error ?? 'same-cutoff orders unavailable'}`);
  if (!r.baskets_available || r.baskets_stale) throw new Error(`Ozon monitor saved partial report: ${r.baskets_error ?? 'baskets unavailable'}`);
  return { rows: r.rows.length, note: JSON.stringify({ mode: 'read_only', products: r.rows.length,
    sales_available: r.sales_available, baskets_available: r.baskets_available, baskets_as_of: r.baskets_as_of,
    issues: r.rows.filter(p => p.issues.length).length, snapshot_at: r.snapshot_at, actionsTaken: 0 }) };
});
