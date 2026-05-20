// Procurement Planner endpoints — Phase 9.0
// One cycle = one manufacturer group = one draft Purchase.
//
// Rules locked:
//   - velocity window:  last 60 days
//   - velocity formula: SUM(qty * bundle_size) / days_with_stock per base SKU
//   - lead time:        65 days (manufacturing 30 + freight 35)
//   - coverage target:  60 days after arrival
//   - MOQ:              14,400 (toothpastes, toothbrushes) · 5,000 (floss, interdental)
//   - in-transit:       only operations.status IN ('production','shipped')
//   - one cycle:        one manufacturer group → one draft Purchase
//   - bundles:          AA = bundle_size 2 · AAAA = bundle_size 4 · rolled up to base_sku
//   - factory + transit warehouses excluded from "available stock"
//   - lifecycle:        only active and new_launch considered
//
// Routes:
//   GET /api/planner/summary       — two cards (Jinxia / Honghui+WDAA) urgency
//   GET /api/planner/suggestions   — detailed plan for ?group=<manufacturer_group_id>

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const r = new Hono<{ Bindings: Env }>();

// Warehouses excluded from "available stock" (factory + virtual transit)
const EXCLUDED_WH = ['gzh', 'yzh', 'dgn', 'otw'];

const PALLET_VOLUME_M3 = 1.44;        // standard EUR pallet useful volume
const CONTAINER_20FT_M3 = 28;          // 20ft cargo cubic capacity
const CONTAINER_40FT_M3 = 56;          // 40ft cargo cubic capacity
const PALLET_MAX = 6;
const FORTYFT_THRESHOLD = 1.2;         // 120% of 20ft → escalate to 40ft

// MOQ by category
function moqFor(category: string, subcategory: string | null): number {
  if (category === 'Floss') return 5000;
  if (category === 'Other' && subcategory === 'Interdental') return 5000;
  // toothpastes, toothbrushes, mouthwash, tongue cleaner → 14,400
  return 14400;
}

// =============================================================================
// Core calculation: returns per-base-SKU rows for a given manufacturer group
// =============================================================================
type PlannerRow = {
  base_sku: string;
  product_name: string;
  category: string;
  subcategory: string | null;
  manufacturer_id: string;
  lifecycle_status: string;
  // carton spec
  ctn_qty: number | null;
  ctn_volume_m3: number | null;
  // metrics
  units_60d: number;
  days_with_stock: number;
  velocity_per_day: number;
  available_stock: number;
  in_transit: number;
  cover_days: number | null;
  // order computation
  raw_need: number;
  moq: number;
  suggested_order: number;
  // carton breakdown for this SKU's contribution to the shipment
  cartons: number;            // ceil(suggested_order / ctn_qty), or 0
  volume_m3: number;          // cartons * ctn_volume_m3
  pallets: number;            // volume / PALLET_VOLUME_M3
  // flags
  dearth_days: number;
  is_new_launch: boolean;
};

async function computeForGroup(
  db: D1Database,
  groupId: string,
  windowDays = 60,
  coverageDays = 60,
  leadTimeDays = 65
): Promise<PlannerRow[]> {
  // 1. find manufacturer_ids in this group
  const mans = await db.prepare(
    `SELECT id FROM manufacturers WHERE group_id = ? AND deleted_at IS NULL`
  ).bind(groupId).all<{ id: string }>();
  const manufacturerIds = mans.results.map(m => m.id);
  if (manufacturerIds.length === 0) return [];

  const manPlaceholders = manufacturerIds.map(() => '?').join(',');
  const whPlaceholders = EXCLUDED_WH.map(() => '?').join(',');

  // 2. base products in this group (only active + new_launch)
  //    Bundle SKUs (DE101AA etc.) get rolled up to base; we list only true base SKUs.
  //    True base = product whose own base_sku IS NULL.
  const baseProductsSql = `
    SELECT
      p.id AS base_sku,
      p.product_name,
      p.category,
      p.subcategory,
      p.manufacturer_id,
      p.lifecycle_status,
      p.ctn_qty,
      p.ctn_volume_m3
    FROM products p
    WHERE p.deleted_at IS NULL
      AND p.manufacturer_id IN (${manPlaceholders})
      AND p.base_sku IS NULL
      AND p.lifecycle_status IN ('active','new_launch')
    ORDER BY p.id
  `;
  const baseProductsRes = await db.prepare(baseProductsSql)
    .bind(...manufacturerIds).all<{
      base_sku: string;
      product_name: string;
      category: string;
      subcategory: string | null;
      manufacturer_id: string;
      lifecycle_status: string;
      ctn_qty: number | null;
      ctn_volume_m3: number | null;
    }>();
  const baseProducts = baseProductsRes.results;
  if (baseProducts.length === 0) return [];

  const baseSkus = baseProducts.map(b => b.base_sku);
  const baseSkuPlaceholders = baseSkus.map(() => '?').join(',');

  // 3. velocity: sales in last 60 days, rolled up to base via bundle_size
  //    Wrap in CTE to avoid D1 GROUP BY quirks with computed columns.
  const velocitySql = `
    WITH sales_per_row AS (
      SELECT
        COALESCE(p.base_sku, p.id) AS base_sku,
        li.qty * COALESCE(p.bundle_size, 1) AS units
      FROM operations o
      JOIN line_items li ON li.operation_id = o.id
      JOIN products p ON p.id = li.product_id
      WHERE o.operation_type = 'sale'
        AND o.status != 'cancelled'
        AND o.deleted_at IS NULL
        AND o.operation_date >= unixepoch('now', '-' || ? || ' days')
        AND COALESCE(p.base_sku, p.id) IN (${baseSkuPlaceholders})
    )
    SELECT base_sku, SUM(units) AS units_60d FROM sales_per_row GROUP BY base_sku
  `;
  const velocityRes = await db.prepare(velocitySql)
    .bind(windowDays, ...baseSkus).all<{ base_sku: string; units_60d: number }>();
  const velocityMap = new Map(velocityRes.results.map(v => [v.base_sku, v.units_60d || 0]));

  // 4. available stock per base SKU (excluding factory + transit warehouses)
  const stockSql = `
    WITH stock_per_row AS (
      SELECT
        COALESCE(p.base_sku, p.id) AS base_sku,
        s.on_hand * COALESCE(p.bundle_size, 1) AS units
      FROM stocks s
      JOIN products p ON p.id = s.product_id
      WHERE s.stock_state = 'on_hand'
        AND s.on_hand > 0
        AND s.warehouse_id NOT IN (${whPlaceholders})
        AND COALESCE(p.base_sku, p.id) IN (${baseSkuPlaceholders})
    )
    SELECT base_sku, SUM(units) AS available FROM stock_per_row GROUP BY base_sku
  `;
  const stockRes = await db.prepare(stockSql)
    .bind(...EXCLUDED_WH, ...baseSkus).all<{ base_sku: string; available: number }>();
  const stockMap = new Map(stockRes.results.map(s => [s.base_sku, s.available || 0]));

  // 5. in-transit: open purchase operations with status production OR shipped
  //    For each such operation, sum line_items qty * bundle_size, rolled up to base.
  const transitSql = `
    WITH transit_per_row AS (
      SELECT
        COALESCE(p.base_sku, p.id) AS base_sku,
        li.qty * COALESCE(p.bundle_size, 1) AS units
      FROM operations o
      JOIN line_items li ON li.operation_id = o.id
      JOIN products p ON p.id = li.product_id
      WHERE o.operation_type = 'purchase'
        AND o.status IN ('production','shipped')
        AND o.deleted_at IS NULL
        AND COALESCE(p.base_sku, p.id) IN (${baseSkuPlaceholders})
    )
    SELECT base_sku, SUM(units) AS units FROM transit_per_row GROUP BY base_sku
  `;
  const transitRes = await db.prepare(transitSql)
    .bind(...baseSkus).all<{ base_sku: string; units: number }>();
  const transitMap = new Map(transitRes.results.map(t => [t.base_sku, t.units || 0]));

  // 6. dearth (out-of-stock) days approximation:
  //    Count distinct days in last 60 with zero on_hand across non-excluded WH.
  //    Implementation note: D1 doesn't store daily stock history,
  //    so we approximate using stock_movements last_movement_at + 0-balance heuristic.
  //    For v1: dearth_days = 0 if current available > 0; else number of days since last positive movement (capped at 60).
  //    A proper dearth calculation comes in Phase 9.1 when daily snapshots accumulate.
  // For now: simple proxy
  const dearthMap = new Map<string, number>();
  for (const b of baseProducts) {
    const avail = stockMap.get(b.base_sku) ?? 0;
    if (avail > 0) {
      dearthMap.set(b.base_sku, 0);
    } else {
      // available is zero now → estimate dearth heuristically as 30 (mid-window default)
      // until daily snapshot system is in place
      dearthMap.set(b.base_sku, 30);
    }
  }

  // 7. assemble per-row computation
  const rows: PlannerRow[] = baseProducts.map(b => {
    const units60d = velocityMap.get(b.base_sku) ?? 0;
    const dearthDays = dearthMap.get(b.base_sku) ?? 0;
    const daysWithStock = Math.max(1, windowDays - dearthDays); // never divide by 0
    const velocityPerDay = units60d / daysWithStock;

    const available = stockMap.get(b.base_sku) ?? 0;
    const inTransit = transitMap.get(b.base_sku) ?? 0;
    const totalCoverPool = available + inTransit;
    const coverDays = velocityPerDay > 0
      ? Math.round(totalCoverPool / velocityPerDay)
      : null; // no sales → cover infinite

    const moq = moqFor(b.category, b.subcategory);
    const isNewLaunch = b.lifecycle_status === 'new_launch';

    const ctnQty = b.ctn_qty && b.ctn_qty > 0 ? b.ctn_qty : 1;
    const ctnVol = b.ctn_volume_m3 || 0;

    let rawNeed = 0;
    let suggested = 0;
    if (isNewLaunch) {
      // New launch: no velocity → seed with MOQ, rounded up to whole cartons
      rawNeed = moq;
      suggested = Math.ceil(moq / ctnQty) * ctnQty;
    } else {
      // target stock pool after arrival = (lead_time + coverage) days of velocity
      const targetPool = velocityPerDay * (leadTimeDays + coverageDays);
      rawNeed = Math.max(0, Math.ceil(targetPool - totalCoverPool));
      if (rawNeed === 0) {
        suggested = 0;
      } else {
        // respect MOQ in units first
        const withMoq = Math.max(rawNeed, moq);
        // then round up to whole cartons
        suggested = Math.ceil(withMoq / ctnQty) * ctnQty;
      }
    }

    // carton breakdown
    const cartons = suggested > 0 ? suggested / ctnQty : 0;
    const volumeM3 = cartons * ctnVol;
    const palletsForSku = volumeM3 / PALLET_VOLUME_M3;

    return {
      base_sku: b.base_sku,
      product_name: b.product_name,
      category: b.category,
      subcategory: b.subcategory,
      manufacturer_id: b.manufacturer_id,
      lifecycle_status: b.lifecycle_status,
      ctn_qty: b.ctn_qty,
      ctn_volume_m3: b.ctn_volume_m3,
      units_60d: units60d,
      days_with_stock: daysWithStock,
      velocity_per_day: Math.round(velocityPerDay * 100) / 100,
      available_stock: available,
      in_transit: inTransit,
      cover_days: coverDays,
      raw_need: rawNeed,
      moq,
      suggested_order: suggested,
      cartons,
      volume_m3: Math.round(volumeM3 * 1000) / 1000,
      pallets: Math.round(palletsForSku * 100) / 100,
      dearth_days: dearthDays,
      is_new_launch: isNewLaunch,
    };
  });

  return rows;
}

// =============================================================================
// Compute three packing scenarios (pallet / 20ft / 40ft)
// Returns total volume + chosen scenario per rules:
//   ≤ 6 pallets        → pallet mode
//   6 ... 120% of 20ft → 20ft full (top up nearest SKUs to fill)
//   > 120% of 20ft     → 40ft full
// =============================================================================
type Scenario = {
  mode: 'pallet' | '20ft' | '40ft';
  total_units: number;
  total_volume_m3: number;
  pallets: number;
  fill_pct: number;   // % of selected container (0..100); pallet mode = 100
  recommended: boolean;
};

function computeScenarios(rows: PlannerRow[]): Scenario[] {
  // Sum what each SKU contributes (already computed in PlannerRow)
  let totalUnits = 0;
  let totalCartons = 0;
  let totalVolume = 0;
  for (const r of rows) {
    if (r.suggested_order <= 0) continue;
    totalUnits += r.suggested_order;
    totalCartons += r.cartons;
    totalVolume += r.volume_m3;
  }
  const pallets = totalVolume / PALLET_VOLUME_M3;

  // Decide recommended mode
  let recommended: 'pallet' | '20ft' | '40ft';
  if (pallets <= PALLET_MAX) {
    recommended = 'pallet';
  } else if (totalVolume <= CONTAINER_20FT_M3 * FORTYFT_THRESHOLD) {
    recommended = '20ft';
  } else {
    recommended = '40ft';
  }

  const palletScenario: Scenario = {
    mode: 'pallet',
    total_units: totalUnits,
    total_volume_m3: Math.round(totalVolume * 100) / 100,
    pallets: Math.round(pallets * 10) / 10,
    fill_pct: 100,
    recommended: recommended === 'pallet',
  };

  const twentyFt: Scenario = {
    mode: '20ft',
    total_units: totalUnits,
    total_volume_m3: Math.round(totalVolume * 100) / 100,
    pallets: Math.round(pallets * 10) / 10,
    fill_pct: Math.round((totalVolume / CONTAINER_20FT_M3) * 100),
    recommended: recommended === '20ft',
  };

  const fortyFt: Scenario = {
    mode: '40ft',
    total_units: totalUnits * 2,
    total_volume_m3: Math.round(totalVolume * 200) / 100,
    pallets: Math.round(pallets * 20) / 10,
    fill_pct: Math.round((totalVolume * 2 / CONTAINER_40FT_M3) * 100),
    recommended: recommended === '40ft',
  };

  return [palletScenario, twentyFt, fortyFt];
}

// =============================================================================
// GET /api/planner/summary
// Returns urgency scoring for each manufacturer_group with active products
// =============================================================================
r.get('/summary', async (c) => {
  const groupsRes = await c.env.DB.prepare(
    `SELECT id, name, notes FROM manufacturer_groups ORDER BY name`
  ).all<{ id: string; name: string; notes: string | null }>();

  const cards = [];
  for (const g of groupsRes.results) {
    const rows = await computeForGroup(c.env.DB, g.id);

    // urgency metrics
    const skusToOrder = rows.filter(r => r.suggested_order > 0).length;
    // "skus_zero" = SKU with zero available AND active velocity (not idle SKUs)
    const skusZero = rows.filter(r =>
      r.available_stock === 0 && r.velocity_per_day > 0 && !r.is_new_launch
    ).length;
    const skusCritical = rows.filter(r =>
      r.cover_days !== null && r.cover_days <= 30 && r.velocity_per_day > 0
    ).length;
    const dearthFlags = rows.filter(r =>
      r.dearth_days > 0 && r.velocity_per_day > 0
    ).length;
    // min_cover only across SKUs with real velocity (skip idle/zero-velocity ones)
    const validCovers = rows
      .filter(r => r.cover_days !== null && r.velocity_per_day > 0)
      .map(r => r.cover_days as number);
    const minCover = validCovers.length > 0 ? Math.min(...validCovers) : null;

    // urgency level: based on real cover among selling SKUs
    let urgency: 'critical' | 'high' | 'calm';
    if (minCover !== null && minCover <= 10) {
      urgency = 'critical';
    } else if (minCover !== null && minCover <= 60) {
      urgency = 'high';
    } else {
      urgency = 'calm';
    }

    // category label (rough — brushes vs pastes etc.)
    const categories = Array.from(new Set(rows.map(r => r.category)));
    cards.push({
      group_id: g.id,
      group_name: g.name,
      notes: g.notes,
      categories,
      sku_count: rows.length,
      skus_to_order: skusToOrder,
      skus_zero: skusZero,
      skus_critical: skusCritical,
      dearth_flags: dearthFlags,
      min_cover_days: minCover,
      urgency,
    });
  }

  // Sort by urgency (critical first, then high, then calm)
  const urgencyRank = { critical: 0, high: 1, calm: 2 };
  cards.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]);

  return ok(c, {
    rules: {
      window_days: 60,
      coverage_days: 60,
      lead_time_days: 65,
      excluded_warehouses: EXCLUDED_WH,
    },
    groups: cards,
  });
});

// =============================================================================
// GET /api/planner/suggestions?group=<manufacturer_group_id>
// Full plan for one manufacturer group
// =============================================================================
r.get('/suggestions', async (c) => {
  const groupId = c.req.query('group');
  if (!groupId) {
    return fail(c, 400, [
      { code: 'missing_param', message: 'group query parameter is required' },
    ]);
  }

  const rows = await computeForGroup(c.env.DB, groupId);
  const scenarios = computeScenarios(rows);

  const groupRow = await c.env.DB.prepare(
    `SELECT id, name, notes FROM manufacturer_groups WHERE id = ?`
  ).bind(groupId).first<{ id: string; name: string; notes: string | null }>();

  if (!groupRow) {
    return fail(c, 404, [
      { code: 'group_not_found', message: `manufacturer_group ${groupId} not found` },
    ]);
  }

  // Sort rows: zero-stock first (most urgent), then by cover_days asc, new_launch last
  const sorted = [...rows].sort((a, b) => {
    if (a.is_new_launch !== b.is_new_launch) return a.is_new_launch ? 1 : -1;
    const aCover = a.cover_days ?? 99999;
    const bCover = b.cover_days ?? 99999;
    return aCover - bCover;
  });

  return ok(c, {
    group: groupRow,
    rules: {
      window_days: 60,
      coverage_days: 60,
      lead_time_days: 65,
      excluded_warehouses: EXCLUDED_WH,
    },
    rows: sorted,
    scenarios,
    totals: {
      sku_count: rows.length,
      skus_to_order: rows.filter(r => r.suggested_order > 0).length,
      total_units_suggested: rows.reduce((s, r) => s + r.suggested_order, 0),
    },
  });
});

export default r;
