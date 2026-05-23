// =============================================================================
// /api/dashboard/sales-breakdown — YTD aggregates for the Home page pies
//
// • By SKU (units)     — units per product, top-10 + Other; revenue carried in
//                        original currency, kept for sorting only.
// • By Partner (USD)   — partner revenue converted to USD across all currencies
//                        via KV `das-fx` snapshot. Technical partners excluded
//                        (partners.is_technical = 1). Top-N + "Other (k partners)".
//
// Returns revenue in USD major units (e.g. 403500.50 = $403,500.50).
// SKU revenue stays in raw mixed currency (display side only uses units anyway).
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import { readLatestPointer, readSnapshot } from '../lib/fx-store';
import { getRateToUsdNano, applyFxToAmount } from '../lib/fx-cbr';

const r = new Hono<{ Bindings: Env }>();

const TOP_N_PARTNERS = 7;

interface PartnerRow {
  partner_id: string;
  partner_name: string | null;
  currency: string;
  revenue: number;
  ops_count: number;
}

r.get('/sales-breakdown', async (c) => {
  const now = new Date();
  const ytdStart = Math.floor(Date.UTC(now.getUTCFullYear(), 0, 1) / 1000);

  // ---- FX snapshot -----------------------------------------------------------
  const latestDate = await readLatestPointer(c.env.FX);
  const fxSnapshot = latestDate ? await readSnapshot(c.env.FX, latestDate) : null;

  // ---- SKU aggregation (units) ----------------------------------------------
  // Technical partners excluded. Mixed-currency revenue is fine here since the
  // UI sorts by units; revenue is kept only as a tie-breaker.
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
      AND o.operation_date >= ?
    GROUP BY li.product_id
    ORDER BY units DESC
  `).bind(ytdStart).all<{ sku: string; units: number; revenue: number; product_name: string | null }>();

  const allSkus = skuResult.results;
  const top10 = allSkus.slice(0, 10);
  const tail = allSkus.slice(10);
  const tailRev = tail.reduce((s, r) => s + (r.revenue || 0), 0);
  const tailUnits = tail.reduce((s, r) => s + (r.units || 0), 0);
  const totalSkuUnits = allSkus.reduce((s, r) => s + (r.units || 0), 0);
  const totalSkuRev = allSkus.reduce((s, r) => s + (r.revenue || 0), 0);

  // ---- Partner aggregation (USD) --------------------------------------------
  // GROUP BY partner+currency so we can convert each row independently,
  // then collapse currencies in JS by summing USD-equivalents per partner_id.
  const partnerRowsRes = await c.env.DB.prepare(`
    SELECT o.partner_id     AS partner_id,
           p.trade_name     AS partner_name,
           o.currency       AS currency,
           SUM(o.total_amount) AS revenue,
           COUNT(*)         AS ops_count
    FROM operations o
    LEFT JOIN partners p ON p.id = o.partner_id
    WHERE o.deleted_at IS NULL
      AND o.operation_type = 'sale'
      AND COALESCE(p.is_technical, 0) = 0
      AND o.operation_date >= ?
    GROUP BY o.partner_id, o.currency
  `).bind(ytdStart).all<PartnerRow>();

  const byPartner = new Map<string, { id: string; label: string; revenue_usd: number; ops_count: number }>();
  for (const row of partnerRowsRes.results) {
    let usd = 0;
    if (fxSnapshot) {
      const rateNano = getRateToUsdNano(fxSnapshot, row.currency);
      if (rateNano !== null) {
        usd = applyFxToAmount(row.revenue || 0, rateNano, row.currency, 'USD');
      } else if (row.currency === 'USD') {
        usd = row.revenue || 0;
      }
    } else if (row.currency === 'USD') {
      // No FX cached at all — at least surface USD-native partners correctly.
      usd = row.revenue || 0;
    }

    const label = friendlyPartnerLabel(row.partner_id, row.partner_name);
    const existing = byPartner.get(row.partner_id);
    if (existing) {
      existing.revenue_usd += usd;
      existing.ops_count   += row.ops_count;
    } else {
      byPartner.set(row.partner_id, {
        id: row.partner_id,
        label,
        revenue_usd: usd,
        ops_count: row.ops_count,
      });
    }
  }

  const sortedPartners = [...byPartner.values()]
    .sort((a, b) => b.revenue_usd - a.revenue_usd);

  const headPartners = sortedPartners.slice(0, TOP_N_PARTNERS);
  const tailPartners = sortedPartners.slice(TOP_N_PARTNERS);

  // Build display list — keep "Other" only if there's actual tail to show.
  const partnerItems: Array<{ id: string; label: string; revenue: number; ops_count: number }> =
    headPartners.map((p) => ({
      id: p.id,
      label: p.label,
      revenue: roundUsd(p.revenue_usd),
      ops_count: p.ops_count,
    }));

  let otherRev = 0, otherOps = 0;
  for (const p of tailPartners) {
    otherRev += p.revenue_usd;
    otherOps += p.ops_count;
  }
  if (tailPartners.length > 0 && otherRev > 0) {
    partnerItems.push({
      id: '_other',
      label: `Other (${tailPartners.length} partner${tailPartners.length === 1 ? '' : 's'})`,
      revenue: roundUsd(otherRev),
      ops_count: otherOps,
    });
  }

  const totalPartnerRev = sortedPartners.reduce((s, p) => s + p.revenue_usd, 0);

  return ok(c, {
    period: {
      from: new Date(ytdStart * 1000).toISOString().slice(0, 10),
      to:   now.toISOString().slice(0, 10),
      label: 'YTD ' + now.getUTCFullYear(),
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
    partners: {
      items: partnerItems,
      total: roundUsd(totalPartnerRev),
      currency: 'USD',
      fx_date: fxSnapshot?.date ?? null,
    },
  });
});

function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}

function friendlyPartnerLabel(id: string, name: string | null): string {
  if (id === 'wb')   return 'Wildberries';
  if (id === 'ozon') return 'Ozon';
  if (id === 'яндекс_пей_продажи_с_нашего_сайта') return 'dasexperten.ru';
  return name || id;
}

export default r;
