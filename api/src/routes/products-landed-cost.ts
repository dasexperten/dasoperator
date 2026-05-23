// =============================================================================
// Products landed cost — break down delivered SKU into factory + freight + customs + delivery + marking.
//
// GET /api/products/:productId/landed-cost
//
// Source: last delivered purchase op containing this SKU (or its base if AA-bundle).
// Allocation:
//   - Each service op tied to the purchase (related_purchase_id) is allocated to
//     each SKU by qty share (qty_sku / total_qty_in_purchase).
//   - Currency conversion uses the latest FX snapshot in KV; RUB → USD.
//   - Marking is hardcoded at 2 RUB/unit for toothpaste category (per business rule).
//
// MVP allocation is qty-weighted (not volume/weight) for simplicity. Heavier items
// like toothpaste under-allocated, lighter items like brushes over-allocated.
// Future iteration: per-SKU weight or carton volume share.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { readLatestPointer, readSnapshot } from '../lib/fx-store';
import { applyFxToAmount, getRateToUsdNano } from '../lib/fx-cbr';

const productsLandedCost = new Hono<{ Bindings: Env }>();

const MARKING_RUB_PER_UNIT_PASTE = 2;
const PASTE_CATEGORIES = new Set(['toothpaste', 'паста', 'паста зубная']);

interface ServiceBreakdownRow {
  subtype: string;
  total_rub: number;
  ops_count: number;
}

productsLandedCost.get('/:productId/landed-cost', async (c) => {
  const productId = c.req.param('productId').toLowerCase();

  // 1. Product info — for category + base-SKU lookup
  const product = await c.env.DB.prepare(
    `SELECT id, product_name, category FROM products WHERE id = ? AND deleted_at IS NULL`
  ).bind(productId).first<{ id: string; product_name: string; category: string | null }>();

  if (!product) {
    return fail(c, 404, [{ code: 'not_found', message: 'Product not found' }]);
  }

  // 2. Find the latest delivered purchase containing this SKU (or its AA-bundle base)
  // For AA bundles: e.g., de202aa rolls up to de202 in some line_items; check both.
  const baseSku = productId.replace(/a+$/, '');
  const skuCandidates = [productId];
  if (baseSku !== productId) skuCandidates.push(baseSku);

  const placeholders = skuCandidates.map(() => '?').join(',');
  const purchase = await c.env.DB.prepare(
    `SELECT o.id, o.operation_date, o.forwarder_ref, o.currency, o.partner_id,
            li.qty, li.unit_price, li.line_amount, li.currency AS line_currency, li.product_id AS line_sku
     FROM operations o
     JOIN line_items li ON li.operation_id = o.id
     WHERE li.product_id IN (${placeholders})
       AND o.operation_type = 'purchase'
       AND o.status IN ('delivered', 'shipped')
       AND o.deleted_at IS NULL
     ORDER BY o.operation_date DESC
     LIMIT 1`
  ).bind(...skuCandidates).first<{
    id: string;
    operation_date: number;
    forwarder_ref: string | null;
    currency: string;
    partner_id: string;
    qty: number;
    unit_price: number;
    line_amount: number;
    line_currency: string | null;
    line_sku: string;
  }>();

  if (!purchase) {
    return ok(c, {
      product_id: productId,
      has_landed_cost: false,
      reason: 'No delivered purchase found for this SKU',
    });
  }

  // 3. Total qty for this purchase — needed for allocation
  const totalQtyRow = await c.env.DB.prepare(
    `SELECT SUM(qty) AS total_qty FROM line_items WHERE operation_id = ?`
  ).bind(purchase.id).first<{ total_qty: number | null }>();
  const totalQty = totalQtyRow?.total_qty ?? 0;
  if (totalQty <= 0) {
    return fail(c, 500, [{ code: 'data_integrity', message: 'Purchase has zero total qty' }]);
  }

  const skuShare = purchase.qty / totalQty;

  // 4. Service ops tied to this purchase
  const serviceRows = await c.env.DB.prepare(
    `SELECT id, service_subtype, total_amount, currency
     FROM operations
     WHERE related_purchase_id = ?
       AND operation_type = 'service'
       AND status = 'issued'
       AND deleted_at IS NULL`
  ).bind(purchase.id).all<{
    id: string;
    service_subtype: string | null;
    total_amount: number;
    currency: string;
  }>();

  // 5. Aggregate by subtype (assume all in RUB for Inter-Freight; defensive otherwise)
  const subtypeTotals: Record<string, ServiceBreakdownRow> = {};
  for (const r of serviceRows.results) {
    const sub = r.service_subtype ?? 'other';
    if (!subtypeTotals[sub]) subtypeTotals[sub] = { subtype: sub, total_rub: 0, ops_count: 0 };
    // Only RUB supported in this MVP — flag if anything else
    if (r.currency !== 'RUB') continue;
    subtypeTotals[sub].total_rub += r.total_amount;
    subtypeTotals[sub].ops_count += 1;
  }

  // 6. FX: RUB → USD using latest CBR snapshot
  // applyFxToAmount returns USD directly (already divided by NANO_FACTOR + rounded to cents)
  const latestDate = await readLatestPointer(c.env.FX);
  const fxSnap = latestDate ? await readSnapshot(c.env.FX, latestDate) : null;
  const rubToUsdNano = fxSnap ? getRateToUsdNano(fxSnap, 'RUB') : null;
  // Fallback if FX missing
  const rubToUsd = (rub: number) => {
    if (rubToUsdNano) {
      return applyFxToAmount(rub, rubToUsdNano, 'RUB');
    }
    return rub / 71.21; // emergency fallback
  };

  // 7. Allocate by SKU share + compute USD
  const allocatedSku: Record<string, { rub: number; usd: number }> = {};
  let totalAllocatedRub = 0;
  for (const sub of Object.values(subtypeTotals)) {
    const allocRub = sub.total_rub * skuShare;
    allocatedSku[sub.subtype] = { rub: allocRub, usd: rubToUsd(allocRub) };
    totalAllocatedRub += allocRub;
  }

  // 8. Factory cost (per-SKU line amount in USD)
  let factoryUsd = purchase.line_amount;
  const lineCcy = purchase.line_currency ?? purchase.currency;
  if (lineCcy === 'CNY') {
    const cnyToUsdNano = fxSnap ? getRateToUsdNano(fxSnap, 'CNY') : null;
    factoryUsd = cnyToUsdNano ? applyFxToAmount(purchase.line_amount, cnyToUsdNano, 'CNY') : purchase.line_amount / 6.79;
  } else if (lineCcy === 'RUB') {
    factoryUsd = rubToUsd(purchase.line_amount);
  }
  const factoryPerUnit = factoryUsd / purchase.qty;

  // 9. Marking — 2 RUB/unit if paste
  const isPaste = product.category ? PASTE_CATEGORIES.has(product.category.toLowerCase()) : false;
  const markingRub = isPaste ? MARKING_RUB_PER_UNIT_PASTE * purchase.qty : 0;
  const markingUsd = rubToUsd(markingRub);

  const landedTotalUsd = factoryUsd + Object.values(allocatedSku).reduce((s, v) => s + v.usd, 0) + markingUsd;
  const landedPerUnit = landedTotalUsd / purchase.qty;

  return ok(c, {
    product_id: productId,
    has_landed_cost: true,
    source: {
      purchase_id: purchase.id,
      purchase_date: purchase.operation_date,
      forwarder_ref: purchase.forwarder_ref,
      supplier_id: purchase.partner_id,
      qty: purchase.qty,
      total_purchase_qty: totalQty,
      sku_share_pct: Math.round(skuShare * 10000) / 100,
    },
    fx: {
      date: latestDate ?? null,
      rub_per_usd: fxSnap && rubToUsdNano ? 1e9 / rubToUsdNano : 71.21,
    },
    factory: {
      currency_paid: lineCcy,
      amount_paid: purchase.line_amount,
      usd_total: factoryUsd,
      usd_per_unit: factoryPerUnit,
    },
    allocated_services: Object.entries(allocatedSku).map(([subtype, v]) => ({
      subtype,
      rub: v.rub,
      usd: v.usd,
      ops_count: subtypeTotals[subtype].ops_count,
    })),
    marking: isPaste ? { rub: markingRub, usd: markingUsd, rate_per_unit_rub: MARKING_RUB_PER_UNIT_PASTE } : null,
    landed: {
      usd_total: landedTotalUsd,
      usd_per_unit: landedPerUnit,
      freight_markup_pct: factoryUsd > 0 ? Math.round((landedTotalUsd - factoryUsd) / factoryUsd * 10000) / 100 : 0,
    },
  });
});

export default productsLandedCost;
