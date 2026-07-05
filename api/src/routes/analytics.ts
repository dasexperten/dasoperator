// =============================================================================
// /api/analytics - cross-cutting dashboard data (not bound to one ERP entity)
//
// Currently: marketplace-summary - aggregates from fbo_stocks_cluster,
// fbo_sales_cluster and marketplace_sync_log (Phase 6.0b + 8.0 + FBO 0058).
// Read-only, no mutations. KV-cached 10 min.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCache, cacheKey } from '../lib/kv-cache';

const analytics = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/analytics/marketplace-summary - Ozon + WB stock & 30d sales
// =============================================================================
//
// Aggregates three D1 tables (all written by the marketplace-sync cron in
// scheduled.ts; see migrations 0014 + 0058):
//   - fbo_stocks_cluster    (current FBO units at cluster grain)
//   - fbo_sales_cluster     (trailing 30d sales units at cluster grain)
//   - marketplace_sync_log  (last successful sync per marketplace)
//
// Returns the data the /analytics dashboard needs to render the marketplace
// block without the frontend talking to D1 directly:
//   {
//     marketplaces: [{ name, fbo_units, sales_30d, last_sync, ... }],
//     top_sku: [{ base_sku, marketplace, units_30d }],
//     per_sku: [{ base_sku, marketplace, fbo_units, sales_30d }]
//   }
//
// KV cache: 10 min (cron writes every 1h Ozon / 4h WB; 10 min is fresh enough
// for a dashboard, and limits D1 query load).
// =============================================================================
analytics.get('/marketplace-summary', async (c) => {
  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('analytics:mp-summary'),
      600,
      async () => {
        const db = c.env.DB;

        // 1. Per-marketplace totals: FBO units + 30d sales units
        //    fbo_stocks_cluster.units is per-cluster; we sum to one number per MP.
        //    fbo_sales_cluster.units_30d is already a trailing-30d aggregate.
        const mpRows = await db
          .prepare(
            `SELECT
               s.marketplace            AS marketplace,
               COALESCE(SUM(s.units), 0) AS fbo_units,
               COALESCE(
                 (SELECT SUM(units_30d) FROM fbo_sales_cluster AS sa WHERE sa.marketplace = s.marketplace),
                 0
               )                         AS sales_30d,
               COALESCE(
                 (SELECT COUNT(DISTINCT base_sku) FROM fbo_stocks_cluster AS sx WHERE sx.marketplace = s.marketplace),
                 0
               )                         AS sku_count_stock,
               COALESCE(
                 (SELECT COUNT(DISTINCT base_sku) FROM fbo_sales_cluster AS sx WHERE sx.marketplace = s.marketplace),
                 0
               )                         AS sku_count_sales
             FROM fbo_stocks_cluster AS s
             GROUP BY s.marketplace
             ORDER BY s.marketplace`
          )
          .all();

        // 2. Last successful sync per marketplace (status='ok')
        const syncRows = await db
          .prepare(
            `SELECT marketplace, MAX(started_at) AS last_sync, MAX(finished_at) AS last_finish
             FROM marketplace_sync_log
             WHERE status = 'ok'
             GROUP BY marketplace`
          )
          .all();

        const syncMap: Record<string, { last_sync: number | null; last_finish: number | null }> = {};
        for (const r of (syncRows.results ?? [])) {
          const mp = String(r.marketplace ?? '');
          syncMap[mp] = {
            last_sync: r.last_sync ? Number(r.last_sync) : null,
            last_finish: r.last_finish ? Number(r.last_finish) : null,
          };
        }

        const marketplaces = (mpRows.results ?? []).map((r) => {
          const mp = String(r.marketplace ?? '');
          const sync = syncMap[mp] ?? { last_sync: null, last_finish: null };
          return {
            marketplace: mp,
            fbo_units: Number(r.fbo_units ?? 0),
            sales_30d: Number(r.sales_30d ?? 0),
            sku_count_stock: Number(r.sku_count_stock ?? 0),
            sku_count_sales: Number(r.sku_count_sales ?? 0),
            last_sync: sync.last_sync,
            last_finish: sync.last_finish,
          };
        });

        // 3. Top-10 SKU across both MPs by 30d units
        const topRows = await db
          .prepare(
            `SELECT base_sku, marketplace, SUM(units_30d) AS units_30d
             FROM fbo_sales_cluster
             GROUP BY base_sku, marketplace
             ORDER BY units_30d DESC
             LIMIT 10`
          )
          .all();
        const top_sku = (topRows.results ?? []).map((r) => ({
          base_sku: String(r.base_sku ?? ''),
          marketplace: String(r.marketplace ?? ''),
          units_30d: Number(r.units_30d ?? 0),
        }));

        // 4. Per-SKU-per-MP detail (for the table view) - top 20 by sales, plus all stock-only rows
        const detailRows = await db
          .prepare(
            `SELECT
               COALESCE(s.base_sku, sa.base_sku) AS base_sku,
               COALESCE(s.marketplace, sa.marketplace) AS marketplace,
               COALESCE(SUM(s.units), 0)           AS fbo_units,
               COALESCE(SUM(sa.units_30d), 0)      AS sales_30d
             FROM fbo_stocks_cluster AS s
             LEFT JOIN fbo_sales_cluster AS sa
               ON sa.marketplace = s.marketplace AND sa.base_sku = s.base_sku
             GROUP BY COALESCE(s.base_sku, sa.base_sku), COALESCE(s.marketplace, sa.marketplace)
             ORDER BY sales_30d DESC, fbo_units DESC
             LIMIT 30`
          )
          .all();
        const per_sku = (detailRows.results ?? []).map((r) => ({
          base_sku: String(r.base_sku ?? ''),
          marketplace: String(r.marketplace ?? ''),
          fbo_units: Number(r.fbo_units ?? 0),
          sales_30d: Number(r.sales_30d ?? 0),
        }));

        return {
          marketplaces,
          top_sku,
          per_sku,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 500, [{ code: 'analytics_db_error', message: msg }]);
  }
});

export default analytics;
