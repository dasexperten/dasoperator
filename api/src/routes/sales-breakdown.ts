// =============================================================================
// /api/dashboard/sales-breakdown — last-30-days product mix for the Home pie
//
// • By SKU (units) — units per product, top-10 + Other
//   Retail only (WB / Ozon / site). No partner breakdown.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';

const r = new Hono<{ Bindings: Env }>();

r.get('/sales-breakdown', async (c) => {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const fromSec = nowSec - 30 * 24 * 60 * 60;

  // RETAIL ONLY — exclude B2B distributors. End-consumer demand mix.
  const RETAIL_PARTNER_IDS = ['wb', 'ozon', 'dasexperten_com', 'яндекс_пей_продажи_с_нашего_сайта'];
  const retailPlaceholders = RETAIL_PARTNER_IDS.map(() => '?').join(',');

  const skuResult = await c.env.DB.prepare(`
    SELECT li.product_id    AS sku,
           SUM(li.qty)      AS units,
           SUM(li.line_amount) AS revenue,
           p.product_name   AS product_name
    FROM line_items li
    JOIN operations o ON o.id = li.operation_id
    LEFT JOIN partners pa ON pa.id = o.partner_id
    LEFT JOIN products p  ON p.id = li.product_id
    WHERE o.deleted_at IS NULL
      AND o.operation_type = 'sale'
      AND COALESCE(pa.is_technical, 0) = 0
      AND o.partner_id IN (${retailPlaceholders})
      AND o.operation_date >= ?
    GROUP BY li.product_id
    ORDER BY units DESC
  `).bind(...RETAIL_PARTNER_IDS, fromSec).all<{ sku: string; units: number; revenue: number; product_name: string | null }>();

  const allSkus = skuResult.results;
  const top10 = allSkus.slice(0, 10);
  const tail = allSkus.slice(10);
  const tailRev = tail.reduce((s, row) => s + (row.revenue || 0), 0);
  const tailUnits = tail.reduce((s, row) => s + (row.units || 0), 0);
  const totalSkuUnits = allSkus.reduce((s, row) => s + (row.units || 0), 0);
  const totalSkuRev = allSkus.reduce((s, row) => s + (row.revenue || 0), 0);

  const fromDate = new Date(fromSec * 1000).toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);

  return ok(c, {
    period: {
      from: fromDate,
      to: toDate,
      label: 'Last 30 days',
    },
    sku: {
      top10: top10.map((s) => ({
        sku: s.sku,
        product_name: s.product_name,
        units: s.units,
        revenue: s.revenue,
      })),
      other: {
        count: tail.length,
        units: tailUnits,
        revenue: tailRev,
      },
      total: totalSkuRev,
      total_units: totalSkuUnits,
      sku_count: allSkus.length,
    },
    // Partners removed from home breakdown (Aram 2026-07-13). Empty shape kept
    // so older clients don't crash if they still read partners.
    partners: {
      items: [],
      total: 0,
      currency: 'USD',
      fx_date: null,
    },
  });
});

export default r;
