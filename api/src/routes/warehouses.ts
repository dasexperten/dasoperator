import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const warehouses = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/warehouses — list all warehouses with basic info
// Used by:
//   - /warehouses page (matrix view headers)
//   - /warehouses/[slug] hub
//   - inventory session creation (to pick warehouse)
// =============================================================================
warehouses.get('/', async (c) => {
  // Optional ownership filters — used by operations form to scope dropdowns:
  //   ?company_id=cmp_dee       → only warehouses owned by DEE (Russia 3PLs)
  //   ?manufacturer_id=mfr_jinxia → only Jinxia's factory warehouse (YZH)
  //   ?partner_id=prt_X         → only partner's warehouses (rare; partners
  //                               usually receive via incoterms, no warehouse)
  const companyId = c.req.query('company_id');
  const manufacturerId = c.req.query('manufacturer_id');
  const partnerId = c.req.query('partner_id');
  // ownership=owner_only restricts the company/manufacturer filter to
  // warehouses where w.owner_*_id matches directly — junction memberships
  // (e.g. bonded/storage roles) are excluded. Used by Sale operations:
  // a seller can only ship from a warehouse it owns, not from one where
  // it's merely a tenant.
  const ownershipMode = c.req.query('ownership');
  const ownerOnly = ownershipMode === 'owner_only';

  // Any of company_id / manufacturer_id triggers junction-aware lookup
  // since both have M:N junction tables (warehouse_companies, warehouse_manufacturers).
  // Partners don't have a junction (B decision: no partner warehouses), so they
  // only check owner_partner_id.
  const useJunction = Boolean(companyId || manufacturerId);

  let sql: string;
  const binds: unknown[] = [];

  if (useJunction) {
    const conditions: string[] = [];

    if (companyId) {
      if (ownerOnly) {
        conditions.push('w.owner_company_id = ?');
        binds.push(companyId);
      } else {
        conditions.push('(w.owner_company_id = ? OR EXISTS (SELECT 1 FROM warehouse_companies wc WHERE wc.warehouse_id = w.id AND wc.company_id = ?))');
        binds.push(companyId, companyId);
      }
    }
    if (manufacturerId) {
      if (ownerOnly) {
        conditions.push('w.owner_manufacturer_id = ?');
        binds.push(manufacturerId);
      } else {
        conditions.push('(w.owner_manufacturer_id = ? OR EXISTS (SELECT 1 FROM warehouse_manufacturers wm WHERE wm.warehouse_id = w.id AND wm.manufacturer_id = ?))');
        binds.push(manufacturerId, manufacturerId);
      }
    }
    if (partnerId) {
      conditions.push('w.owner_partner_id = ?');
      binds.push(partnerId);
    }

    sql = `
      SELECT
        w.id, w.code, w.name, w.country, w.city, w.warehouse_type,
        w.owner_id, w.owner_company_id, w.owner_manufacturer_id, w.owner_partner_id,
        w.external_provider, w.external_customer_id, w.external_sync_at,
        w.notes, w.created_at, w.updated_at
      FROM warehouses w
      WHERE w.deleted_at IS NULL
        AND ${conditions.join(' AND ')}
    `;
  } else {
    sql = `
      SELECT
        id, code, name, country, city, warehouse_type,
        owner_id, owner_company_id, owner_manufacturer_id, owner_partner_id,
        external_provider, external_customer_id, external_sync_at,
        notes, created_at, updated_at
      FROM warehouses
      WHERE deleted_at IS NULL
    `;

    if (partnerId) {
      sql += ' AND owner_partner_id = ?';
      binds.push(partnerId);
    }
  }

  sql += ' ORDER BY code';

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    warehouses: result.results,
  });
});

// =============================================================================
// GET /api/warehouses/:id — single warehouse with last counted snapshot
// =============================================================================
warehouses.get('/:id', async (c) => {
  const id = c.req.param('id');

  const wh = await c.env.DB.prepare(`
    SELECT
      id, code, name, country, city, warehouse_type,
      owner_id, owner_company_id, owner_manufacturer_id, owner_partner_id,
      external_provider, external_customer_id, external_sync_at,
      notes, created_at, updated_at
    FROM warehouses
    WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();

  if (!wh) {
    return fail(c, 404, [{ code: 'warehouse_not_found', message: id }]);
  }

  // Latest counted_at across all stocks at this warehouse (max)
  const latest = await c.env.DB.prepare(`
    SELECT MAX(last_counted_at) AS last_counted_at,
           MAX(last_movement_at) AS last_movement_at
    FROM stocks
    WHERE warehouse_id = ?
  `).bind(id).first<{ last_counted_at: number | null; last_movement_at: number | null }>();

  return ok(c, {
    ...wh,
    last_counted_at: latest?.last_counted_at ?? null,
    last_movement_at: latest?.last_movement_at ?? null,
  });
});

// =============================================================================
// GET /api/warehouses/:id/bundling-suggestions
// =============================================================================
// Detects probable packing/unpacking activity from stock_movements alone, with
// no human-entered bundling operations required.
//
// SKU convention (Das Experten internal):
//   de201       → single unit          (bundle_size = 1)
//   de201aa     → 2-pack of de201      (bundle_size = 2)
//   de201aaaa   → 4-pack of de201      (bundle_size = 4)
// Suffix 'aa' / 'aaaa' is treated as the same product *family* as the base SKU.
//
// Detection rule (per family, per warehouse, per calendar day):
//   • aggregate sum of qty across all movements of each family-member that day
//   • take the family member where qty change is NEGATIVE (consumed)
//   • take the family member where qty change is POSITIVE (produced)
//   • check whether the abs values match the bundle_size ratio:
//       PACK   : |Δsingles| ≈ Δbundle × bundle_size
//       UNPACK : |Δbundle|  × bundle_size ≈ Δsingles
//   • return a row per family-day showing inferred direction, ratio match,
//     and a confidence score
// =============================================================================
warehouses.get('/:id/bundling-suggestions', async (c) => {
  const warehouseId = c.req.param('id');
  const days = parseInt(c.req.query('days') ?? '30', 10);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  // 1) Load products with their family (base SKU) + bundle_size
  const products = await c.env.DB.prepare(`
    SELECT id, product_name, bundle_size
      FROM products
     WHERE deleted_at IS NULL
  `).all<{ id: string; product_name: string; bundle_size: number | null }>();

  // Group by base SKU stripping suffix [a]{2,}$
  const familyByBase = new Map<string, Array<{ id: string; product_name: string; bundle_size: number }>>();
  const productMeta = new Map<string, { base: string; size: number; name: string }>();
  for (const p of products.results ?? []) {
    const m = p.id.match(/^(de\d+)(a+)?$/);
    if (!m) continue;
    const base = m[1]!;
    const size = (p.bundle_size && p.bundle_size > 0) ? p.bundle_size : 1;
    productMeta.set(p.id, { base, size, name: p.product_name });
    if (!familyByBase.has(base)) familyByBase.set(base, []);
    familyByBase.get(base)!.push({ id: p.id, product_name: p.product_name, bundle_size: size });
  }
  // Only keep families with more than one variant
  const productsInFamilies = new Set<string>();
  for (const [base, members] of familyByBase) {
    if (members.length > 1) {
      for (const m of members) productsInFamilies.add(m.id);
    } else {
      familyByBase.delete(base);
    }
  }
  if (productsInFamilies.size === 0) {
    return ok(c, { warehouse_id: warehouseId, days, suggestions: [] });
  }

  // 2) Aggregate qty per (family, day, product) from stock_movements
  const placeholders = Array.from(productsInFamilies).map(() => '?').join(',');
  const params = [warehouseId, cutoff, ...Array.from(productsInFamilies)];
  const movements = await c.env.DB.prepare(`
    SELECT product_id,
           DATE(occurred_at, 'unixepoch') AS day,
           SUM(quantity) AS day_delta,
           MIN(occurred_at) AS first_ts,
           MAX(occurred_at) AS last_ts,
           COUNT(*) AS mv_count,
           GROUP_CONCAT(DISTINCT source) AS sources
      FROM stock_movements
     WHERE warehouse_id = ?
       AND occurred_at >= ?
       AND product_id IN (${placeholders})
     GROUP BY product_id, day
  `).bind(...params).all<{
    product_id: string;
    day: string;
    day_delta: number;
    first_ts: number;
    last_ts: number;
    mv_count: number;
    sources: string;
  }>();

  // 3) Group by (family, day) and detect pack/unpack pairs
  type DayBucket = {
    base: string;
    day: string;
    members: Map<string, { product_id: string; bundle_size: number; product_name: string; delta: number; first_ts: number; last_ts: number; sources: string }>;
  };
  const buckets = new Map<string, DayBucket>();
  for (const mv of movements.results ?? []) {
    const meta = productMeta.get(mv.product_id);
    if (!meta) continue;
    const key = `${meta.base}::${mv.day}`;
    if (!buckets.has(key)) buckets.set(key, { base: meta.base, day: mv.day, members: new Map() });
    buckets.get(key)!.members.set(mv.product_id, {
      product_id: mv.product_id,
      bundle_size: meta.size,
      product_name: meta.name,
      delta: mv.day_delta,
      first_ts: mv.first_ts,
      last_ts: mv.last_ts,
      sources: mv.sources,
    });
  }

  // 4) For each bucket, look for opposing-sign movements within the same family
  const TOLERANCE = 0.05; // 5% tolerance to allow scrap/wastage
  const suggestions: Array<any> = [];
  for (const bucket of buckets.values()) {
    const members = Array.from(bucket.members.values());
    if (members.length < 2) continue;
    const negatives = members.filter(m => m.delta < 0);
    const positives = members.filter(m => m.delta > 0);
    if (negatives.length === 0 || positives.length === 0) continue;

    for (const neg of negatives) {
      for (const pos of positives) {
        const negUnits = Math.abs(neg.delta) * neg.bundle_size; // unit-equivalent count
        const posUnits = pos.delta * pos.bundle_size;
        if (negUnits === 0 || posUnits === 0) continue;

        // Direction is determined by bundle_size: smaller-size product is "singles"
        // larger-size product is "bundle". Same-size pairs are ignored (no bundling).
        if (neg.bundle_size === pos.bundle_size) continue;

        const single = neg.bundle_size < pos.bundle_size ? neg : pos;
        const bundle = neg.bundle_size < pos.bundle_size ? pos : neg;
        const direction = neg.bundle_size < pos.bundle_size ? 'pack' : 'unpack';

        // Ratio check
        const singleUnits = Math.abs(single.delta);              // raw count
        const bundleUnitsAsSingles = Math.abs(bundle.delta) * bundle.bundle_size;
        const diff = Math.abs(singleUnits - bundleUnitsAsSingles);
        const ratio = singleUnits === 0 ? 0 : diff / singleUnits;
        if (ratio > TOLERANCE * 4) continue; // skip wild mismatches (>20% off)

        // Confidence: exact match within same hour = high, fuzzy match across day = medium
        const tsDiff = Math.abs(bundle.first_ts - single.first_ts);
        const isExact = ratio < 0.01;
        const isSameMinute = tsDiff < 60;
        let confidence: 'high' | 'medium' | 'low';
        if (isExact && isSameMinute) confidence = 'high';
        else if (isExact || ratio < TOLERANCE) confidence = 'medium';
        else confidence = 'low';

        suggestions.push({
          warehouse_id: warehouseId,
          family_base: bucket.base,
          day: bucket.day,
          direction,
          single: {
            product_id: single.product_id,
            product_name: single.product_name,
            bundle_size: single.bundle_size,
            delta: single.delta,
            sources: single.sources,
          },
          bundle: {
            product_id: bundle.product_id,
            product_name: bundle.product_name,
            bundle_size: bundle.bundle_size,
            delta: bundle.delta,
            sources: bundle.sources,
          },
          single_units: singleUnits,
          bundle_units_in_singles: bundleUnitsAsSingles,
          variance_units: diff,
          variance_pct: Math.round(ratio * 10000) / 100,
          ts_diff_seconds: tsDiff,
          confidence,
        });
      }
    }
  }

  // Sort by day desc, confidence desc
  const confOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? 1 : -1;
    return confOrder[a.confidence as keyof typeof confOrder] - confOrder[b.confidence as keyof typeof confOrder];
  });

  return ok(c, { warehouse_id: warehouseId, days, suggestions });
});

export default warehouses;
