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

export default products;
