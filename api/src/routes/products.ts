import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryAll } from '../lib/db';
import { getProductPrice } from '../lib/pricelist';

// =============================================================================
// GET /api/products/lookup
// Query params: ?sku=DE201 (exact) OR ?sku_prefix=DE (prefix search)
// Returns: array of products with manufacturer info joined
// =============================================================================

const products = new Hono<{ Bindings: Env }>();

const lookupSchema = z.object({
  sku: z.string().min(1).optional(),
  sku_prefix: z.string().min(1).optional(),
}).refine(
  (data) => data.sku || data.sku_prefix,
  { message: 'Either sku or sku_prefix must be provided' }
);

products.get('/lookup', async (c) => {
  const query = lookupSchema.safeParse(c.req.query());
  if (!query.success) {
    return fail(c, 400, [{
      code: 'invalid_query',
      message: 'Either sku or sku_prefix must be provided',
      details: { issues: query.error.issues },
    }]);
  }

  const { sku, sku_prefix } = query.data;
  let sql: string;
  let binds: unknown[];

  if (sku) {
    // Exact match — by id (which is the slug like prd_de201) OR product_name partial
    sql = `
      SELECT
        p.id, p.product_name, p.invoice_label, p.category,
        p.barcode, p.weight_kg, p.volume_m3_micro,
        p.manufacturer_id, m.name as manufacturer_name, m.country as manufacturer_country
      FROM products p
      LEFT JOIN manufacturers m ON p.manufacturer_id = m.id
      WHERE p.deleted_at IS NULL
        AND (p.id = ? OR LOWER(p.product_name) LIKE LOWER(?))
      ORDER BY p.id
      LIMIT 20
    `;
    binds = [`prd_${sku.toLowerCase()}`, `%${sku}%`];
  } else {
    // Prefix search by id
    sql = `
      SELECT
        p.id, p.product_name, p.invoice_label, p.category,
        p.barcode, p.weight_kg, p.volume_m3_micro,
        p.manufacturer_id, m.name as manufacturer_name, m.country as manufacturer_country
      FROM products p
      LEFT JOIN manufacturers m ON p.manufacturer_id = m.id
      WHERE p.deleted_at IS NULL
        AND p.id LIKE ?
      ORDER BY p.id
      LIMIT 20
    `;
    binds = [`prd_${sku_prefix!.toLowerCase()}%`];
  }

  const results = await queryAll(c.env.DB, sql, ...binds);

  return ok(c, {
    count: results.length,
    products: results,
  });
});

// =============================================================================
// GET /api/products — list with optional filters
// Filters: ?category=Toothpaste, ?manufacturer_id=mfr_x, ?search=term
// =============================================================================
products.get('/', async (c) => {
  const category = c.req.query('category');
  const manufacturerId = c.req.query('manufacturer_id');
  const search = c.req.query('search');

  let sql = `
    SELECT
      p.id, p.product_name, p.invoice_label, p.category, p.manufacturer_id,
      p.weight_kg, p.barcode, p.pieces_per_case, p.hs_code, p.ctn_qty,
      p.country_of_origin, p.unit_net_weight_g,
      m.name AS manufacturer_name
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (category) { sql += ` AND p.category = ?`; binds.push(category); }
  if (manufacturerId) { sql += ` AND p.manufacturer_id = ?`; binds.push(manufacturerId); }
  if (search) {
    sql += ` AND (p.product_name LIKE ? OR p.id LIKE ? OR p.invoice_label LIKE ?)`;
    const q = `%${search}%`;
    binds.push(q, q, q);
  }

  sql += ` ORDER BY p.id ASC`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    products: result.results,
  });
});

// =============================================================================
// GET /api/products/:id — single product full row + manufacturer + packaging
// =============================================================================
// =============================================================================
// GET /api/products/with-stock
// Returns all products joined with current stock totals + per-warehouse
// breakdown. Per-warehouse array sorted by warehouse.code (stable order so
// sparkline bars represent same warehouse position across rows).
//
// IMPORTANT: This must be declared BEFORE products.get('/:id', ...) below,
// otherwise Hono's router matches /with-stock against the dynamic /:id
// handler first (router precedence is by declaration order in some modes).
// =============================================================================

interface StockJoinRow {
  product_id: string;
  product_name: string;
  invoice_label: string;
  manufacturer_id: string | null;
  pieces_per_case: number;
  warehouse_id: string;
  code: string;
  warehouse_name: string;
  on_hand: number;
}

products.get('/with-stock', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT
      p.id AS product_id,
      p.product_name,
      p.invoice_label,
      p.manufacturer_id,
      p.pieces_per_case,
      w.id AS warehouse_id,
      w.code,
      w.name AS warehouse_name,
      COALESCE(s.on_hand, 0) AS on_hand
    FROM products p
    CROSS JOIN warehouses w
    LEFT JOIN stocks s
      ON s.product_id = p.id
     AND s.warehouse_id = w.id
    WHERE p.deleted_at IS NULL
      AND w.deleted_at IS NULL
    ORDER BY p.product_name, w.code
  `).all<StockJoinRow>();

  const byProduct = new Map<string, {
    id: string;
    product_name: string;
    invoice_label: string;
    manufacturer_id: string | null;
    pieces_per_case: number;
    total_on_hand: number;
    warehouses: Array<{ warehouse_id: string; code: string; name: string; on_hand: number }>;
  }>();

  for (const row of result.results) {
    let prod = byProduct.get(row.product_id);
    if (!prod) {
      prod = {
        id: row.product_id,
        product_name: row.product_name,
        invoice_label: row.invoice_label,
        manufacturer_id: row.manufacturer_id,
        pieces_per_case: row.pieces_per_case,
        total_on_hand: 0,
        warehouses: [],
      };
      byProduct.set(row.product_id, prod);
    }
    prod.warehouses.push({
      warehouse_id: row.warehouse_id,
      code: row.code,
      name: row.warehouse_name,
      on_hand: row.on_hand,
    });
    prod.total_on_hand += row.on_hand;
  }

  return ok(c, {
    count: byProduct.size,
    products: Array.from(byProduct.values()),
  });
});

// =============================================================================
// GET /api/products/:id — single product full row + manufacturer + packaging
// =============================================================================
products.get('/:id', async (c) => {
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(`
    SELECT
      p.*,
      m.name AS manufacturer_name, m.country AS manufacturer_country,
      m.city AS manufacturer_city,
      pm.name AS packaging_manufacturer_name, pm.country AS packaging_manufacturer_country
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    LEFT JOIN manufacturers pm ON pm.id = p.packaging_manufacturer_id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).bind(id).first();

  if (!row) {
    return fail(c, 404, [{ code: 'product_not_found', message: `Product ${id} not found` }]);
  }

  return ok(c, row);
});

// =============================================================================
// GET /api/products/:id/prices — all price_types for this SKU
// Phase 5.1-pricer-r2: R2 pricelist first (source of truth), D1 fallback.
// Returns unified format compatible with UI ProductPriceRow type.
// =============================================================================
products.get('/:id/prices', async (c) => {
  const id = c.req.param('id');

  const prod = await c.env.DB.prepare(
    'SELECT id FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  if (!prod) {
    return fail(c, 404, [{ code: 'product_not_found', message: id }]);
  }

  // Reference price types from D1 (for code/description/used_by metadata)
  const priceTypes = await c.env.DB.prepare(`
    SELECT id, code, description, currency, used_by_entity
    FROM price_types
    ORDER BY id ASC
  `).all<{
    id: string;
    code: string;
    description: string | null;
    currency: string;
    used_by_entity: string | null;
  }>();

  const now = Math.floor(Date.now() / 1000);

  // For each price_type: R2 first, D1 fallback
  const enriched = await Promise.all(
    priceTypes.results.map(async (pt) => {
      // Try R2
      try {
        const r2 = await getProductPrice(c.env, id, pt.id);
        if (r2) {
          const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(r2.currency);
          const minorFactor = isZeroDecimal ? 1 : 100;
          return {
            id: `r2_${pt.id}_${id}`,
            price_type_id: pt.id,
            price_type_code: pt.code,
            price_type_description: pt.description,
            price_type_currency: pt.currency,
            used_by_entity: pt.used_by_entity,
            sell_price: Math.round(r2.price * minorFactor),  // minor units
            currency: r2.currency,
            effective_from: null,
            effective_until: null,
            notes: null,
            is_active: 1,
            source: 'pricer_r2',
            source_file: r2.source,
          };
        }
      } catch {
        // fall through to D1
      }

      // D1 fallback
      const dbRow = await c.env.DB.prepare(`
        SELECT
          pp.id, pp.price_type_id, pp.sell_price, pp.currency,
          pp.effective_from, pp.effective_until, pp.notes,
          CASE
            WHEN pp.effective_until IS NULL THEN 1
            WHEN pp.effective_until > ? THEN 1
            ELSE 0
          END AS is_active
        FROM product_prices pp
        WHERE pp.product_id = ? AND pp.price_type_id = ?
        ORDER BY pp.effective_from DESC
        LIMIT 1
      `).bind(now, id, pt.id).first<{
        id: string;
        price_type_id: string;
        sell_price: number;
        currency: string;
        effective_from: number;
        effective_until: number | null;
        notes: string | null;
        is_active: number;
      }>();

      if (dbRow) {
        return {
          id: dbRow.id,
          price_type_id: dbRow.price_type_id,
          price_type_code: pt.code,
          price_type_description: pt.description,
          price_type_currency: pt.currency,
          used_by_entity: pt.used_by_entity,
          sell_price: dbRow.sell_price,
          currency: dbRow.currency,
          effective_from: dbRow.effective_from,
          effective_until: dbRow.effective_until,
          notes: dbRow.notes,
          is_active: dbRow.is_active,
          source: 'd1_fallback',
          source_file: null,
        };
      }

      return null;
    })
  );

  const prices = enriched.filter((x): x is NonNullable<typeof x> => x !== null);
  return ok(c, { count: prices.length, prices });
});

// =============================================================================
// GET /api/products/:id/activity — recent stock movements for this SKU
// =============================================================================
products.get('/:id/activity', async (c) => {
  const id = c.req.param('id');
  const limitRaw = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitRaw ?? '20', 10) || 20, 1), 200);

  const prod = await c.env.DB.prepare(
    'SELECT id FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(id).first();
  if (!prod) {
    return fail(c, 404, [{ code: 'product_not_found', message: id }]);
  }

  const result = await c.env.DB.prepare(`
    SELECT
      m.id, m.movement_type AS type,
      m.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
      m.quantity, m.balance_after,
      m.source, m.source_ref_type, m.source_ref_id,
      m.reason, m.notes,
      m.performed_by, m.performed_at,
      m.created_at
    FROM stock_movements m
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    WHERE m.product_id = ?
    ORDER BY m.performed_at DESC, m.created_at DESC
    LIMIT ?
  `).bind(id, limit).all();

  return ok(c, {
    count: result.results.length,
    limit,
    activity: result.results,
  });
});

export default products;
