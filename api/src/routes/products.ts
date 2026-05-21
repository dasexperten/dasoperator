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

  // Marketplace sales partners for Monthly Sales / Coef DEE calculation:
  // wb (Wildberries), ozon (Ozon), site (Retail CRM dasexperten.ru)
  // Russia stock: lbr (Lyubertsy) + flp (Flypost) + srn (Saransk) + wb + ozon FBO
  let sql = `
    SELECT
      p.id, p.product_name, p.invoice_label, p.category, p.manufacturer_id,
      p.weight_kg, p.barcode, p.pieces_per_case, p.hs_code, p.ctn_qty,
      p.country_of_origin, p.unit_net_weight_g,
      m.name AS manufacturer_name,
      COALESCE((
        SELECT SUM(li.qty)
        FROM line_items li
        JOIN operations o ON o.id = li.operation_id
        WHERE li.product_id = p.id
          AND o.deleted_at IS NULL
          AND o.operation_type = 'sale'
          AND o.partner_id IN ('wb', 'ozon', 'яндекс_пей_продажи_с_нашего_сайта')
          AND o.operation_date >= (unixepoch() - 30 * 86400)
      ), 0) AS monthly_sales,
      COALESCE((
        SELECT SUM(li.qty)
        FROM line_items li
        JOIN operations o ON o.id = li.operation_id
        WHERE li.product_id = p.id
          AND o.deleted_at IS NULL
          AND o.operation_type = 'sale'
          AND o.partner_id IN ('wb', 'ozon', 'яндекс_пей_продажи_с_нашего_сайта')
          AND o.operation_date >= (unixepoch() - 90 * 86400)
      ), 0) AS qty_90d,
      COALESCE((
        SELECT SUM(s.on_hand)
        FROM stocks s
        WHERE s.product_id = p.id
          AND s.warehouse_id IN ('lbr', 'flp', 'srn', 'wb', 'ozon')
      ), 0) AS russia_stock
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (category) { sql += ` AND p.category = ?`; binds.push(category); }
  if (manufacturerId) { sql += ` AND p.id IN (SELECT product_id FROM product_manufacturers WHERE manufacturer_id = ?)`; binds.push(manufacturerId); }
  if (search) {
    sql += ` AND (p.product_name LIKE ? OR p.id LIKE ? OR p.invoice_label LIKE ?)`;
    const q = `%${search}%`;
    binds.push(q, q, q);
  }

  sql += ` ORDER BY p.id ASC`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  // Compute coef_dee and signal in JS — keep DB query clean
  const products = (result.results as any[]).map((p) => {
    const avg3mo = p.qty_90d > 0 ? p.qty_90d / 3 : 0;
    const coef = avg3mo > 0 ? p.russia_stock / avg3mo : null;
    
    let signal: string;
    if (coef === null) {
      signal = p.russia_stock > 0 ? 'dead' : 'inactive';
    } else if (coef === 0 && p.monthly_sales > 0) {
      signal = 'out_of_stock';
    } else if (coef < 2) {
      signal = 'critical';
    } else if (coef < 3) {
      signal = 'warning';
    } else if (coef < 6) {
      signal = 'healthy';
    } else if (coef < 12) {
      signal = 'surplus';
    } else {
      signal = 'severe_surplus';
    }
    
    // Drop qty_90d from response — only intermediate
    const { qty_90d, ...rest } = p;
    return {
      ...rest,
      coef_dee: coef !== null ? Math.round(coef * 100) / 100 : null,
      signal,
    };
  });

  return ok(c, {
    count: products.length,
    products,
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
  in_production: number;
  marketplace_ozon: number;
  marketplace_wb: number;
}

products.get('/with-stock', async (c) => {
  // Per-warehouse on_hand + in_production breakdown.
  // OTW (otw, virtual warehouse) is summed separately as on_the_way
  // since it appears in its own UI column, not as a regular warehouse cell.
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
      COALESCE(s_on.on_hand, 0) AS on_hand,
      COALESCE(s_prod.on_hand, 0) AS in_production,
      COALESCE(oz.qty, 0) AS marketplace_ozon,
      COALESCE(wb.qty, 0) AS marketplace_wb
    FROM products p
    CROSS JOIN warehouses w
    LEFT JOIN stocks s_on
      ON s_on.product_id = p.id
     AND s_on.warehouse_id = w.id
     AND s_on.stock_state = 'on_hand'
    LEFT JOIN stocks s_prod
      ON s_prod.product_id = p.id
     AND s_prod.warehouse_id = w.id
     AND s_prod.stock_state = 'in_production'
    LEFT JOIN (
      SELECT base_sku, SUM(fbo_available * pack_factor) AS qty
      FROM marketplace_stocks_ozon
      GROUP BY base_sku
    ) oz ON oz.base_sku = p.id
    LEFT JOIN (
      SELECT base_sku, SUM(quantity * pack_factor) AS qty
      FROM marketplace_stocks_wb
      GROUP BY base_sku
    ) wb ON wb.base_sku = p.id
    WHERE p.deleted_at IS NULL
      AND w.deleted_at IS NULL
      AND w.id != 'otw'
    ORDER BY p.product_name, w.code
  `).all<StockJoinRow>();

  // OTW totals per product (single sum across the virtual warehouse)
  const otwResult = await c.env.DB.prepare(`
    SELECT product_id, SUM(on_hand) AS qty
    FROM stocks
    WHERE warehouse_id = 'otw' AND stock_state = 'in_transit'
    GROUP BY product_id
  `).all<{ product_id: string; qty: number }>();

  const otwByProduct = new Map<string, number>();
  for (const row of otwResult.results || []) {
    otwByProduct.set(row.product_id, row.qty);
  }

  const byProduct = new Map<string, {
    id: string;
    product_name: string;
    invoice_label: string;
    manufacturer_id: string | null;
    pieces_per_case: number;
    total_on_hand: number;
    marketplace_ozon: number;
    marketplace_wb: number;
    on_the_way: number;
    warehouses: Array<{ warehouse_id: string; code: string; name: string; on_hand: number; in_production: number }>;
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
        marketplace_ozon: row.marketplace_ozon,
        marketplace_wb: row.marketplace_wb,
        on_the_way: otwByProduct.get(row.product_id) ?? 0,
        warehouses: [],
      };
      byProduct.set(row.product_id, prod);
    }
    prod.warehouses.push({
      warehouse_id: row.warehouse_id,
      code: row.code,
      name: row.warehouse_name,
      on_hand: row.on_hand,
      in_production: row.in_production,
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

  // SINGLE SOURCE OF TRUTH: D1 product_prices.
  // R2 .md pricelists kept as archive only; no code reads them anymore.
  const now = Math.floor(Date.now() / 1000);

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

  // For each price_type: latest D1 row (active or most recent closed).
  const enriched = await Promise.all(
    priceTypes.results.map(async (pt) => {
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
          AND (pp.effective_until IS NULL OR pp.effective_until > ?)
        ORDER BY pp.effective_from DESC
        LIMIT 1
      `).bind(now, id, pt.id, now).first<{
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
          source: 'd1',
          source_file: null,
        };
      }
      return null;
    })
  );

  const prices = enriched.filter((r): r is NonNullable<typeof r> => r !== null);
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


// =============================================================================
// POST /api/products — create new SKU
// Required: id, product_name, invoice_label, category, manufacturer_id
// All other fields optional. Returns the created row.
// =============================================================================
const createSchema = z.object({
  id: z.string().min(1).max(50).transform((s) => s.toLowerCase().trim()),
  product_name: z.string().min(1).max(200),
  invoice_label: z.string().min(1).max(200),
  category: z.enum(['Toothpaste', 'Toothbrush', 'Floss', 'Other']),
  subcategory: z.string().max(100).nullable().optional(),
  manufacturer_id: z.string().min(1),

  barcode: z.string().max(50).nullable().optional(),
  pieces_per_case: z.number().int().min(1).optional().default(1),
  ctn_qty: z.number().int().min(0).nullable().optional(),
  ctn_weight_gross_kg: z.number().min(0).nullable().optional(),
  ctn_dim_l_cm: z.number().min(0).nullable().optional(),
  ctn_dim_w_cm: z.number().min(0).nullable().optional(),
  ctn_dim_h_cm: z.number().min(0).nullable().optional(),
  unit_net_weight_g: z.number().min(0).nullable().optional(),
  hs_code: z.string().max(20).nullable().optional(),
  country_of_origin: z.string().max(100).nullable().optional(),
  weight_kg: z.number().int().min(0).nullable().optional(),
  volume_m3_micro: z.number().int().min(0).nullable().optional(),
  description_ru: z.string().nullable().optional(),
  description_en: z.string().nullable().optional(),
  description_cn: z.string().nullable().optional(),
  invoice_label_ru: z.string().max(300).nullable().optional(),
  invoice_label_en: z.string().max(300).nullable().optional(),
  invoice_label_cn: z.string().max(300).nullable().optional(),
  packaging_manufacturer_id: z.string().nullable().optional(),
  buy_price: z.number().int().min(0).nullable().optional(),
  buy_currency: z.string().length(3).nullable().optional(),
  buy_term: z.string().max(50).nullable().optional(),
  notes: z.string().nullable().optional(),
});

products.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, [{ code: 'invalid_json', message: 'Request body must be JSON' }]);

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{ code: 'invalid_body', message: 'Validation failed', details: { issues: parsed.error.issues } }]);
  }
  const data = parsed.data;

  // Check duplicate id
  const dup = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(data.id).first();
  if (dup) {
    return fail(c, 409, [{ code: 'product_exists', message: `Product with id ${data.id} already exists` }]);
  }

  // Check manufacturer exists
  const mfr = await c.env.DB.prepare('SELECT id FROM manufacturers WHERE id = ?').bind(data.manufacturer_id).first();
  if (!mfr) {
    return fail(c, 400, [{ code: 'invalid_manufacturer', message: `Manufacturer ${data.manufacturer_id} does not exist` }]);
  }

  // Check packaging_manufacturer if provided
  if (data.packaging_manufacturer_id) {
    const pm = await c.env.DB.prepare('SELECT id FROM manufacturers WHERE id = ?').bind(data.packaging_manufacturer_id).first();
    if (!pm) {
      return fail(c, 400, [{ code: 'invalid_packaging_manufacturer', message: `Packaging manufacturer ${data.packaging_manufacturer_id} does not exist` }]);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(`
    INSERT INTO products (
      id, product_name, invoice_label, category, subcategory, manufacturer_id,
      barcode, pieces_per_case, ctn_qty, ctn_weight_gross_kg,
      ctn_dim_l_cm, ctn_dim_w_cm, ctn_dim_h_cm,
      unit_net_weight_g, hs_code, country_of_origin,
      weight_kg, volume_m3_micro,
      description_ru, description_en, description_cn,
      invoice_label_ru, invoice_label_en, invoice_label_cn,
      packaging_manufacturer_id,
      buy_price, buy_currency, buy_term, notes,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `).bind(
    data.id, data.product_name, data.invoice_label, data.category, data.subcategory ?? null, data.manufacturer_id,
    data.barcode ?? null, data.pieces_per_case ?? 1, data.ctn_qty ?? null, data.ctn_weight_gross_kg ?? null,
    data.ctn_dim_l_cm ?? null, data.ctn_dim_w_cm ?? null, data.ctn_dim_h_cm ?? null,
    data.unit_net_weight_g ?? null, data.hs_code ?? null, data.country_of_origin ?? null,
    data.weight_kg ?? null, data.volume_m3_micro ?? null,
    data.description_ru ?? null, data.description_en ?? null, data.description_cn ?? null,
    data.invoice_label_ru ?? null, data.invoice_label_en ?? null, data.invoice_label_cn ?? null,
    data.packaging_manufacturer_id ?? null,
    data.buy_price ?? null, data.buy_currency ?? null, data.buy_term ?? null, data.notes ?? null,
    now, now
  ).run();

  const created = await c.env.DB.prepare(`
    SELECT p.*, m.name AS manufacturer_name, m.country AS manufacturer_country
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.id = ?
  `).bind(data.id).first();

  return ok(c, created);
});

// =============================================================================
// PUT /api/products/:id — update existing SKU
// All fields optional except id (from URL). Only provided fields are updated.
// =============================================================================
const updateSchema = createSchema.partial().omit({ id: true });

products.put('/:id', async (c) => {
  const id = c.req.param('id').toLowerCase();
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, [{ code: 'invalid_json', message: 'Request body must be JSON' }]);

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{ code: 'invalid_body', message: 'Validation failed', details: { issues: parsed.error.issues } }]);
  }
  const data = parsed.data;

  const existing = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').bind(id).first();
  if (!existing) {
    return fail(c, 404, [{ code: 'product_not_found', message: `Product ${id} not found` }]);
  }

  if (data.manufacturer_id) {
    const mfr = await c.env.DB.prepare('SELECT id FROM manufacturers WHERE id = ?').bind(data.manufacturer_id).first();
    if (!mfr) {
      return fail(c, 400, [{ code: 'invalid_manufacturer', message: `Manufacturer ${data.manufacturer_id} does not exist` }]);
    }
  }
  if (data.packaging_manufacturer_id) {
    const pm = await c.env.DB.prepare('SELECT id FROM manufacturers WHERE id = ?').bind(data.packaging_manufacturer_id).first();
    if (!pm) {
      return fail(c, 400, [{ code: 'invalid_packaging_manufacturer', message: `Packaging manufacturer ${data.packaging_manufacturer_id} does not exist` }]);
    }
  }

  // Build dynamic UPDATE — only fields that were sent
  const fields: string[] = [];
  const binds: unknown[] = [];

  const allowed = [
    'product_name', 'invoice_label', 'category', 'subcategory', 'manufacturer_id',
    'barcode', 'pieces_per_case', 'ctn_qty', 'ctn_weight_gross_kg',
    'ctn_dim_l_cm', 'ctn_dim_w_cm', 'ctn_dim_h_cm',
    'unit_net_weight_g', 'hs_code', 'country_of_origin',
    'weight_kg', 'volume_m3_micro',
    'description_ru', 'description_en', 'description_cn',
    'invoice_label_ru', 'invoice_label_en', 'invoice_label_cn',
    'packaging_manufacturer_id',
    'buy_price', 'buy_currency', 'buy_term', 'notes',
  ] as const;

  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      binds.push((data as Record<string, unknown>)[key] ?? null);
    }
  }

  if (fields.length === 0) {
    return fail(c, 400, [{ code: 'no_changes', message: 'No fields to update' }]);
  }

  fields.push('updated_at = ?');
  binds.push(Math.floor(Date.now() / 1000));
  binds.push(id);

  await c.env.DB.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).bind(...binds).run();

  const updated = await c.env.DB.prepare(`
    SELECT p.*, m.name AS manufacturer_name, m.country AS manufacturer_country
    FROM products p
    LEFT JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE p.id = ?
  `).bind(id).first();

  return ok(c, updated);
});


export default products;

