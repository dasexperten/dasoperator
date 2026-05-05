import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryAll } from '../lib/db';

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
// GET /api/products/with-stock
// Returns all products joined with current stock totals + per-warehouse
// breakdown. Per-warehouse array sorted by warehouse.code (stable order so
// sparkline bars represent same warehouse position across rows).
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

  // Group by product
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

export default products;
