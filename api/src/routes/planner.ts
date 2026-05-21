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
import { getPricelist } from '../lib/pricelist';

const r = new Hono<{ Bindings: Env }>();

// Warehouses excluded from "available stock" (factory + virtual transit)
const EXCLUDED_WH = ['gzh', 'yzh', 'dgn', 'otw'];
// Russian warehouses used when stock_zone=russia
const RUSSIA_WH = ['lbr', 'srn', 'flp', 'ozon', 'wb'];

const PALLET_VOLUME_M3 = 1.44;        // standard EUR pallet useful volume
const CONTAINER_20FT_M3 = 28;          // 20ft cargo cubic capacity
const CONTAINER_40FT_M3 = 56;          // 40ft cargo cubic capacity
const PALLET_MAX = 6;
const FORTYFT_THRESHOLD = 1.2;         // 120% of 20ft → escalate to 40ft

// MOQ by category
// MOQ in CARTONS — the factory minimum is naturally expressed in cartons.
// Returns the minimum number of cartons for the given product category.
function moqCartonsFor(category: string, subcategory: string | null): number {
  if (category === 'Floss') return 18;                                  // ~5000 units / 288 ctn_qty
  if (category === 'Other' && subcategory === 'Interdental') return 18; // same
  if (category === 'Toothpaste') return 150;                            // 150 ctn × 72 = 10,800 pastes
  return 50;                                                            // brushes, mouthwash, tongue cleaner — 50 cartons regardless of bundle_size
}

// Converts MOQ-in-cartons to MOQ-in-units for a specific row.
function moqFor(category: string, subcategory: string | null, ctnQty: number | null): number {
  const cartons = moqCartonsFor(category, subcategory);
  const qty = (ctnQty && ctnQty > 0) ? ctnQty : 1;
  return cartons * qty;
}

// =============================================================================
// Core calculation: returns per-base-SKU rows for a given manufacturer group
// =============================================================================
type PlannerRow = {
  base_sku: string;             // actual product_id ('de120', 'de120aa', 'de120aaaa')
  product_name: string;
  category: string;
  subcategory: string | null;
  manufacturer_id: string;
  lifecycle_status: string;
  // pack info — distinguishes 1-pack / 2-pack / 4-pack rows
  bundle_size: number;          // 1, 2, or 4
  base_sku_link: string | null; // parent base for bundle rows; null for true base
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
  // money
  unit_price: number | null;  // purchase price per unit, in selected currency
  amount: number | null;      // suggested_order * unit_price
  // flags
  dearth_days: number;
  is_new_launch: boolean;
};

async function computeForGroup(
  env: Env,
  groupId: string,
  stockZone: 'russia' | 'worldwide' = 'russia',
  currency: 'cny' | 'usd' = 'cny',
  windowDays = 60,
  coverageDays = 90,
  leadTimeDays = 70
): Promise<PlannerRow[]> {
  const db = env.DB;
  // Load purchasing price map (lower-cased SKU keys)
  const priceTypeId = currency === 'cny' ? 'purchase_cny' : 'export_usd';
  let priceMap: Record<string, number> = {};
  try {
    const pricelist = await getPricelist(env, priceTypeId);
    if (pricelist) {
      // pricelist.prices keys are uppercase (DE125, DE126AAAA, etc.)
      priceMap = {};
      for (const [k, v] of Object.entries(pricelist.prices)) {
        priceMap[k.toLowerCase()] = v;
      }
    }
  } catch (e) {
    // fail soft — leave priceMap empty if pricelist unavailable
  }
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
      p.ctn_volume_m3,
      COALESCE(p.bundle_size, 1) AS bundle_size,
      p.base_sku AS base_sku_link
    FROM products p
    WHERE p.deleted_at IS NULL
      AND p.manufacturer_id IN (${manPlaceholders})
      AND p.lifecycle_status IN ('active','new_launch')
      AND NOT (p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1)
    ORDER BY COALESCE(p.base_sku, p.id), COALESCE(p.bundle_size, 1)
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
      bundle_size: number;
      base_sku_link: string | null;
    }>();
  const baseProducts = baseProductsRes.results;
  if (baseProducts.length === 0) return [];

  const baseSkus = baseProducts.map(b => b.base_sku);
  const baseSkuPlaceholders = baseSkus.map(() => '?').join(',');

  // 3. velocity: sales in last 60 days, rolled up to base via bundle_size
  //    Wrap in CTE to avoid D1 GROUP BY quirks with computed columns.
  // Bundle rollup rule:
  //  - Toothpaste bundles → rollup to base × bundle_size (factory ships one carton of 72 pastes;
  //    consumer-pack split into 1-pack vs 2-pack is decided at packaging stage).
  //  - Toothbrush / floss / other bundles → stay as separate rows (different factory SKU, different cartons).
  const velocitySql = `
    WITH sales_per_row AS (
      SELECT
        CASE
          WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
            THEN p.base_sku
          ELSE p.id
        END AS rollup_sku,
        CASE
          WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
            THEN li.qty * p.bundle_size
          ELSE li.qty
        END AS units
      FROM operations o
      JOIN line_items li ON li.operation_id = o.id
      JOIN products p ON p.id = li.product_id
      WHERE o.operation_type = 'sale'
        AND o.status != 'cancelled'
        AND o.deleted_at IS NULL
        AND o.operation_date >= unixepoch('now', '-' || ? || ' days')
        AND o.partner_id != 'dasex_group'  -- exclude intra-group transfers (DEE→DEI etc.); only real retail/marketplace sales count for velocity
    )
    SELECT rollup_sku AS base_sku, SUM(units) AS units_60d
    FROM sales_per_row
    WHERE rollup_sku IN (${baseSkuPlaceholders})
    GROUP BY rollup_sku
  `;
  const velocityRes = await db.prepare(velocitySql)
    .bind(windowDays, ...baseSkus).all<{ base_sku: string; units_60d: number }>();
  const velocityMap = new Map(velocityRes.results.map(v => [v.base_sku, v.units_60d || 0]));

  // 4. available stock per base SKU — depends on stockZone
  //    russia:    Russian warehouses (lbr/srn/flp/ozon/wb)
  //               PLUS open purchases (production/shipped) whose warehouse_to_id is in Russia
  //    worldwide: all warehouses (still excluding factory ownership warehouses since those
  //               are raw material, but including everything else)
  //               PLUS all open purchases (production/shipped)
  //
  //    For simplicity, we use a single union query: stocks (on_hand state, filtered by warehouse country)
  //    + transit units (purchase operations production/shipped, filtered by destination country).
  const isRussia = stockZone === 'russia';

  // 4a. On-hand stock in matching warehouses
  let stockSql: string;
  let stockBinds: unknown[];
  if (isRussia) {
    const ruPlaceholders = RUSSIA_WH.map(() => '?').join(',');
    stockSql = `
      WITH stock_per_row AS (
        SELECT
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN p.base_sku
            ELSE p.id
          END AS rollup_sku,
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN s.on_hand * p.bundle_size
            ELSE s.on_hand
          END AS units
        FROM stocks s
        JOIN products p ON p.id = s.product_id
        WHERE s.stock_state = 'on_hand'
          AND s.on_hand > 0
          AND s.warehouse_id IN (${ruPlaceholders})
      )
      SELECT rollup_sku AS base_sku, SUM(units) AS available
      FROM stock_per_row
      WHERE rollup_sku IN (${baseSkuPlaceholders})
      GROUP BY rollup_sku
    `;
    stockBinds = [...RUSSIA_WH, ...baseSkus];
  } else {
    // worldwide: exclude factory raw warehouses (gzh/yzh) + virtual otw
    const excludeForWorld = ['gzh', 'yzh', 'otw'];
    const exclPlaceholders = excludeForWorld.map(() => '?').join(',');
    stockSql = `
      WITH stock_per_row AS (
        SELECT
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN p.base_sku
            ELSE p.id
          END AS rollup_sku,
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN s.on_hand * p.bundle_size
            ELSE s.on_hand
          END AS units
        FROM stocks s
        JOIN products p ON p.id = s.product_id
        WHERE s.stock_state = 'on_hand'
          AND s.on_hand > 0
          AND s.warehouse_id NOT IN (${exclPlaceholders})
      )
      SELECT rollup_sku AS base_sku, SUM(units) AS available
      FROM stock_per_row
      WHERE rollup_sku IN (${baseSkuPlaceholders})
      GROUP BY rollup_sku
    `;
    stockBinds = [...excludeForWorld, ...baseSkus];
  }
  const stockRes = await db.prepare(stockSql)
    .bind(...stockBinds).all<{ base_sku: string; available: number }>();
  const stockMap = new Map(stockRes.results.map(s => [s.base_sku, s.available || 0]));

  // 4b. In-transit: open purchases (production/shipped) — filter by destination country if russia mode
  let transitSql: string;
  let transitBinds: unknown[];
  if (isRussia) {
    transitSql = `
      WITH transit_per_row AS (
        SELECT
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN p.base_sku
            ELSE p.id
          END AS rollup_sku,
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN li.qty * p.bundle_size
            ELSE li.qty
          END AS units
        FROM operations o
        JOIN line_items li ON li.operation_id = o.id
        JOIN products p ON p.id = li.product_id
        JOIN warehouses w ON w.id = o.warehouse_to_id
        WHERE o.operation_type = 'purchase'
          AND o.status IN ('production','shipped')
          AND o.deleted_at IS NULL
          AND w.country = 'Russia'
      )
      SELECT rollup_sku AS base_sku, SUM(units) AS units
      FROM transit_per_row
      WHERE rollup_sku IN (${baseSkuPlaceholders})
      GROUP BY rollup_sku
    `;
    transitBinds = [...baseSkus];
  } else {
    transitSql = `
      WITH transit_per_row AS (
        SELECT
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN p.base_sku
            ELSE p.id
          END AS rollup_sku,
          CASE
            WHEN p.category = 'Toothpaste' AND COALESCE(p.bundle_size, 1) > 1
              THEN li.qty * p.bundle_size
            ELSE li.qty
          END AS units
        FROM operations o
        JOIN line_items li ON li.operation_id = o.id
        JOIN products p ON p.id = li.product_id
        WHERE o.operation_type = 'purchase'
          AND o.status IN ('production','shipped')
          AND o.deleted_at IS NULL
      )
      SELECT rollup_sku AS base_sku, SUM(units) AS units
      FROM transit_per_row
      WHERE rollup_sku IN (${baseSkuPlaceholders})
      GROUP BY rollup_sku
    `;
    transitBinds = [...baseSkus];
  }
  const transitRes = await db.prepare(transitSql)
    .bind(...transitBinds).all<{ base_sku: string; units: number }>();
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

    // available_stock already represents what's "in our hands or coming to selected zone"
    const stockOnly = stockMap.get(b.base_sku) ?? 0;
    const inTransit = transitMap.get(b.base_sku) ?? 0;
    // Merged stock — this is what the UI shows in the "Stock" column
    const available = stockOnly + inTransit;
    const totalCoverPool = available;
    const coverDays = velocityPerDay > 0
      ? Math.round(totalCoverPool / velocityPerDay)
      : null; // no sales → cover infinite

    const moq = moqFor(b.category, b.subcategory, b.ctn_qty);
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
      bundle_size: b.bundle_size,
      base_sku_link: b.base_sku_link,
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
      unit_price: priceMap[b.base_sku] ?? null,
      amount: priceMap[b.base_sku] != null && suggested > 0
        ? Math.round(priceMap[b.base_sku]! * suggested * 100) / 100
        : null,
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
    const rows = await computeForGroup(c.env, g.id);

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
      coverage_days: 90,
      lead_time_days: 70,
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

  const stockZone = (c.req.query('stock_zone') === 'worldwide' ? 'worldwide' : 'russia') as 'russia' | 'worldwide';
  const currency = (c.req.query('currency') === 'usd' ? 'usd' : 'cny') as 'cny' | 'usd';

  const rows = await computeForGroup(c.env, groupId, stockZone, currency);
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
      coverage_days: 90,
      lead_time_days: 70,
      stock_zone: stockZone,
      currency,
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

// =============================================================================
// GET /api/planner/options?group=<manufacturer_group_id>
// Returns dropdown options for the Create Draft modal:
//   - manufacturers in the group (with abbreviation)
//   - companies (DEE/DEI/DEASEAN/DEC) with abbreviation
//   - warehouses (factory side filtered by group, destination filtered later by entity)
// =============================================================================
r.get('/options', async (c) => {
  const groupId = c.req.query('group');
  if (!groupId) return fail(c, 400, [{ code: 'missing_param', message: 'group required' }]);

  // Manufacturers in this group + their partner row for abbreviation
  // Many factories share a partner row (Honghui factory → partners.id='honghui').
  const mfrRes = await c.env.DB.prepare(`
    SELECT m.id as manufacturer_id, m.name as manufacturer_name,
           p.id as partner_id, p.trade_name, p.abbreviation, p.country
    FROM manufacturers m
    LEFT JOIN partners p ON p.id = m.id
    WHERE m.group_id = ?
    ORDER BY m.name
  `).bind(groupId).all<{
    manufacturer_id: string; manufacturer_name: string;
    partner_id: string | null; trade_name: string | null;
    abbreviation: string | null; country: string | null;
  }>();

  // Companies (our entities)
  const compRes = await c.env.DB.prepare(`
    SELECT id, abbreviation, trade_name, jurisdiction, base_currency
    FROM companies
    WHERE deleted_at IS NULL
    ORDER BY id
  `).all<{
    id: string; abbreviation: string | null; trade_name: string;
    jurisdiction: string | null; base_currency: string | null;
  }>();

  // Warehouses — all, UI filters by entity
  const whRes = await c.env.DB.prepare(`
    SELECT id, name, country FROM warehouses ORDER BY country, id
  `).all<{ id: string; name: string; country: string | null }>();

  // Active contracts (CNY/USD) — UI matches (entity × partner × currency)
  const contractRes = await c.env.DB.prepare(`
    SELECT id, contract_no, partner_id, our_company_id, currency, signed_date, expiry_date
    FROM contracts
    WHERE status = 'active' AND deleted_at IS NULL
      AND currency IN ('CNY', 'USD')
  `).all<{
    id: string; contract_no: string; partner_id: string;
    our_company_id: string; currency: string;
    signed_date: number | null; expiry_date: number | null;
  }>();

  return ok(c, {
    manufacturers: mfrRes.results,
    companies: compRes.results,
    warehouses: whRes.results,
    contracts: contractRes.results,
  });
});

// =============================================================================
// POST /api/planner/create-draft
// Creates a draft purchase operation + line items atomically.
// Reference format: YYYY{ManufAbbrev}-{EntityAbbrev}-YYMMDD
//   e.g. 2026YGZH-DEE-260521
// =============================================================================
r.post('/create-draft', async (c) => {
  let body: any;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'bad_json', message: 'invalid JSON body' }]); }

  // Validate required fields
  const required = ['our_company_id', 'manufacturer_partner_id', 'contract_id',
                    'warehouse_from_id', 'warehouse_to_id', 'currency', 'line_items'];
  for (const k of required) {
    if (!body[k]) return fail(c, 400, [{ code: 'missing_field', message: `${k} required` }]);
  }
  if (!Array.isArray(body.line_items) || body.line_items.length === 0) {
    return fail(c, 400, [{ code: 'no_line_items', message: 'at least one line_item required' }]);
  }

  // Fetch entity abbreviation
  const company = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM companies WHERE id = ?'
  ).bind(body.our_company_id).first<{ id: string; abbreviation: string | null }>();
  if (!company) return fail(c, 404, [{ code: 'company_not_found', message: body.our_company_id }]);

  // Fetch manufacturer partner abbreviation
  const mfrPartner = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM partners WHERE id = ?'
  ).bind(body.manufacturer_partner_id).first<{ id: string; abbreviation: string | null }>();
  if (!mfrPartner) return fail(c, 404, [{ code: 'manufacturer_not_found', message: body.manufacturer_partner_id }]);

  // Verify contract belongs to (entity, partner, currency)
  const contract = await c.env.DB.prepare(
    'SELECT id, partner_id, our_company_id, currency FROM contracts WHERE id = ? AND status = \'active\''
  ).bind(body.contract_id).first<{ id: string; partner_id: string; our_company_id: string; currency: string }>();
  if (!contract) return fail(c, 404, [{ code: 'contract_not_found', message: body.contract_id }]);
  if (contract.our_company_id !== body.our_company_id ||
      contract.partner_id !== body.manufacturer_partner_id ||
      contract.currency !== body.currency) {
    return fail(c, 400, [{
      code: 'contract_mismatch',
      message: `Contract does not match (entity=${body.our_company_id}, partner=${body.manufacturer_partner_id}, currency=${body.currency})`,
    }]);
  }

  // Generate reference
  const opDate = body.operation_date ?? Math.floor(Date.now() / 1000);
  const d = new Date(opDate * 1000);
  const yyyy = d.getUTCFullYear();
  const yy = String(yyyy).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mfrAbbr = (mfrPartner.abbreviation || mfrPartner.id).toUpperCase();
  const entAbbr = (company.abbreviation || company.id).toUpperCase();
  let reference = `${yyyy}${mfrAbbr}-${entAbbr}-${yy}${mm}${dd}`;

  // Disambiguate if reference taken (e.g. same day, same group, second draft)
  let suffix = 0;
  while (true) {
    const probeRef = suffix === 0 ? reference : `${reference}-${suffix}`;
    const exists = await c.env.DB.prepare(
      'SELECT 1 FROM operations WHERE reference = ?'
    ).bind(probeRef).first();
    if (!exists) { reference = probeRef; break; }
    suffix++;
    if (suffix > 99) return fail(c, 500, [{ code: 'reference_collision', message: 'too many drafts today' }]);
  }

  // Verify all products exist
  const productIds = body.line_items.map((li: any) => li.product_id);
  const productPlaceholders = productIds.map(() => '?').join(',');
  const productRes = await c.env.DB.prepare(
    `SELECT id, invoice_label FROM products WHERE id IN (${productPlaceholders})`
  ).bind(...productIds).all<{ id: string; invoice_label: string | null }>();
  const productMap = new Map(productRes.results.map(p => [p.id, p]));
  for (const li of body.line_items) {
    if (!productMap.has(li.product_id)) {
      return fail(c, 404, [{ code: 'product_not_found', message: li.product_id }]);
    }
  }

  // Compute line items & total
  const opId = 'op_' + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let totalAmount = 0;

  const lineRows = body.line_items.map((li: any) => {
    const product = productMap.get(li.product_id)!;
    const qty = Number(li.qty) || 0;
    const cartons = Number(li.cartons) || 0;
    const unitPrice = Number(li.unit_price) || 0;
    const lineAmount = Math.round(qty * unitPrice * 100) / 100;
    totalAmount += lineAmount;
    return {
      id: 'li_' + crypto.randomUUID(),
      operation_id: opId,
      product_id: li.product_id,
      item_description: li.item_description ?? product.invoice_label ?? '',
      qty,
      cartons,
      inner_boxes: 0,
      unit_price: unitPrice,
      discount_pct: 0,
      unit_price_after_disc: unitPrice,
      line_amount: lineAmount,
      currency: body.currency,
      line_usd_equiv: null,
      created_at: now,
      updated_at: now,
    };
  });

  // Atomic batch insert: operation + line_items
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`
      INSERT INTO operations (
        id, reference, operation_date, operation_type, status,
        our_company_id, manufacturer_id, partner_id,
        warehouse_from_id, warehouse_to_id,
        contract_id, currency, total_amount,
        vat_rate, dei_layer, via_dei,
        delivery_status, operation_track,
        notes, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'purchase', 'draft',
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        0, 0, 0,
        'pending', 'goods',
        ?, ?, ?
      )
    `).bind(
      opId, reference, opDate,
      body.our_company_id, body.manufacturer_partner_id, body.manufacturer_partner_id,
      body.warehouse_from_id, body.warehouse_to_id,
      body.contract_id, body.currency, Math.round(totalAmount * 100) / 100,
      body.notes ?? `Created from planner — ${body.line_items.length} SKUs`,
      now, now
    ),
    ...lineRows.map((l: any) => c.env.DB.prepare(`
      INSERT INTO line_items (
        id, operation_id, product_id, item_description,
        qty, cartons, inner_boxes,
        unit_price, discount_pct, unit_price_after_disc, line_amount,
        currency, line_usd_equiv,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      l.id, l.operation_id, l.product_id, l.item_description,
      l.qty, l.cartons, l.inner_boxes,
      l.unit_price, l.discount_pct, l.unit_price_after_disc, l.line_amount,
      l.currency, l.line_usd_equiv,
      l.created_at, l.updated_at
    )),
  ];
  await c.env.DB.batch(stmts);

  return ok(c, {
    operation_id: opId,
    reference,
    total_amount: Math.round(totalAmount * 100) / 100,
    currency: body.currency,
    line_items_count: lineRows.length,
    total_units: lineRows.reduce((s: number, l: any) => s + l.qty, 0),
  });
});

export default r;
