// Dashboard sales breakdown endpoint — Phase 8.2
// Provides aggregated data for the YTD breakdown pies on /

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';

const r = new Hono<{ Bindings: Env }>();

const SITE_PARTNER = 'яндекс_пей_продажи_с_нашего_сайта';
const MP_PARTNERS = ['wb', 'ozon', SITE_PARTNER] as const;

// GET /api/dashboard/sales-breakdown
// Returns YTD (from Jan 1 of current year) aggregates by SKU and by partner.
// SKU = net revenue from line_items (post-commission per our PnL calc).
// Partner = gross revenue from operations.total_amount (what customers paid).
r.get('/sales-breakdown', async (c) => {
  const now = new Date();
  const ytdStart = Math.floor(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).getTime() / 1000);

  // SKU aggregation (net)
  const skuResult = await c.env.DB.prepare(`
    SELECT li.product_id AS sku,
           SUM(li.qty) AS units,
           SUM(li.line_amount) AS revenue,
           p.product_name AS product_name
    FROM line_items li
    JOIN operations o ON o.id = li.operation_id
    LEFT JOIN products p ON p.id = li.product_id
    WHERE o.deleted_at IS NULL
      AND o.operation_type = 'sale'
      AND o.partner_id IN ('wb', 'ozon', ?)
      AND o.operation_date >= ?
    GROUP BY li.product_id
    ORDER BY revenue DESC
  `).bind(SITE_PARTNER, ytdStart).all<{ sku: string; units: number; revenue: number; product_name: string | null }>();

  const allSkus = skuResult.results;
  const top10 = allSkus.slice(0, 10);
  const tail = allSkus.slice(10);
  const tailRev = tail.reduce((s, r) => s + (r.revenue || 0), 0);
  const totalSkuRev = allSkus.reduce((s, r) => s + (r.revenue || 0), 0);

  // Partner aggregation (gross)
  const partnerResult = await c.env.DB.prepare(`
    SELECT o.partner_id AS partner_id,
           SUM(o.total_amount) AS revenue,
           COUNT(*) AS ops_count
    FROM operations o
    WHERE o.deleted_at IS NULL
      AND o.operation_type = 'sale'
      AND o.partner_id IN ('wb', 'ozon', ?)
      AND o.operation_date >= ?
    GROUP BY o.partner_id
    ORDER BY revenue DESC
  `).bind(SITE_PARTNER, ytdStart).all<{ partner_id: string; revenue: number; ops_count: number }>();

  const partners = partnerResult.results.map((p) => ({
    id: p.partner_id,
    label:
      p.partner_id === 'wb' ? 'Wildberries' :
      p.partner_id === 'ozon' ? 'Ozon' :
      p.partner_id === SITE_PARTNER ? 'dasexperten.ru' :
      p.partner_id,
    revenue: p.revenue || 0,
    ops_count: p.ops_count || 0,
  }));
  const totalPartnerRev = partners.reduce((s, p) => s + p.revenue, 0);

  return ok(c, {
    period: {
      from: new Date(ytdStart * 1000).toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
      label: `YTD ${now.getUTCFullYear()}`,
    },
    sku: {
      top10: top10.map((r) => ({
        sku: r.sku,
        product_name: r.product_name,
        units: r.units || 0,
        revenue: r.revenue || 0,
      })),
      other: {
        count: tail.length,
        revenue: tailRev,
      },
      total: totalSkuRev,
      sku_count: allSkus.length,
    },
    partners: {
      items: partners,
      total: totalPartnerRev,
    },
  });
});

export default r;
