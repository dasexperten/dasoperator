import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { applyMovement } from '../lib/inventory';

const stocks = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/stocks — list current stock levels
// Filters: warehouse_id, product_id
// JOINs: warehouse_code, product_name, pieces_per_case
// =============================================================================
stocks.get('/', async (c) => {
  const warehouseId = c.req.query('warehouse_id');
  const productId = c.req.query('product_id');

  let sql = `
    SELECT
      s.id, s.warehouse_id, w.code, w.name,
      s.product_id, p.product_name, p.invoice_label, p.pieces_per_case,
      s.on_hand, s.last_movement_at, s.last_counted_at, s.last_counted_by, s.updated_at
    FROM stocks s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    LEFT JOIN products p ON s.product_id = p.id
    WHERE 1=1
  `;
  const binds: unknown[] = [];

  if (warehouseId) { sql += ` AND s.warehouse_id = ?`; binds.push(warehouseId); }
  if (productId) { sql += ` AND s.product_id = ?`; binds.push(productId); }

  sql += ` ORDER BY w.code, p.product_name`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    stocks: result.results,
  });
});

// =============================================================================
// GET /api/stocks/:warehouse_id/:product_id — single stock cell
// =============================================================================
stocks.get('/:warehouse_id/:product_id', async (c) => {
  const warehouseId = c.req.param('warehouse_id');
  const productId = c.req.param('product_id');

  const row = await c.env.DB.prepare(`
    SELECT
      s.id, s.warehouse_id, w.code, w.name,
      s.product_id, p.product_name, p.pieces_per_case,
      s.on_hand, s.last_movement_at, s.last_counted_at, s.last_counted_by, s.updated_at
    FROM stocks s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    LEFT JOIN products p ON s.product_id = p.id
    WHERE s.warehouse_id = ? AND s.product_id = ?
  `).bind(warehouseId, productId).first();

  if (!row) {
    // Return 0 stock instead of 404 — semantically "no stock" is not an error
    return ok(c, {
      warehouse_id: warehouseId,
      product_id: productId,
      on_hand: 0,
      last_movement_at: null,
      last_counted_at: null,
    });
  }

  return ok(c, row);
});

// =============================================================================
// POST /api/stocks/:warehouse_id/:product_id/recount
// Quick set-to-value: computes delta from current, creates adjustment movement
// =============================================================================
const recountSchema = z.object({
  counted_qty: z.number().int().nonnegative(),
  reason: z.string().nullable().optional(),
  performed_by: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

stocks.post('/:warehouse_id/:product_id/recount', async (c) => {
  const warehouseId = c.req.param('warehouse_id');
  const productId = c.req.param('product_id');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = recountSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  // Verify warehouse + product exist
  const wh = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(warehouseId).first();
  if (!wh) return fail(c, 404, [{ code: 'warehouse_not_found', message: warehouseId }]);

  const prod = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').bind(productId).first();
  if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: productId }]);

  // Read current on_hand (0 if no row)
  const current = await c.env.DB.prepare(
    'SELECT on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ?'
  ).bind(warehouseId, productId).first<{ on_hand: number }>();
  const currentQty = current?.on_hand ?? 0;
  const delta = data.counted_qty - currentQty;

  if (delta === 0) {
    return ok(c, {
      warehouse_id: warehouseId,
      product_id: productId,
      counted_qty: data.counted_qty,
      previous_on_hand: currentQty,
      delta: 0,
      movement_id: null,
    }, ['No change — counted matches current']);
  }

  try {
    const result = await applyMovement(c.env.DB, {
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'adjustment',
      quantity: delta,
      source: 'manual',
      reason: data.reason ?? `recount: ${currentQty} → ${data.counted_qty}`,
      notes: data.notes ?? null,
      performed_by: data.performed_by ?? null,
    });

    // Update last_counted_at, last_counted_by on stocks
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      'UPDATE stocks SET last_counted_at = ?, last_counted_by = ? WHERE warehouse_id = ? AND product_id = ?'
    ).bind(now, data.performed_by ?? null, warehouseId, productId).run();

    return ok(c, {
      warehouse_id: warehouseId,
      product_id: productId,
      counted_qty: data.counted_qty,
      previous_on_hand: currentQty,
      delta,
      movement_id: result.movement_id,
      balance_after: result.balance_after,
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'recount_failed', message: 'Failed to apply recount',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }
});

export default stocks;

// =============================================================================
// Sub-router mounted at /api/products to add :id/stock endpoint
// =============================================================================
export const productStock = new Hono<{ Bindings: Env }>();

productStock.get('/:id/stock', async (c) => {
  const productId = c.req.param('id');

  const product = await c.env.DB.prepare(
    'SELECT id, product_name, pieces_per_case FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(productId).first();
  if (!product) return fail(c, 404, [{ code: 'product_not_found', message: productId }]);

  const result = await c.env.DB.prepare(`
    SELECT
      s.warehouse_id, w.code, w.name,
      s.on_hand, s.last_movement_at, s.last_counted_at
    FROM stocks s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE s.product_id = ?
    ORDER BY w.code
  `).bind(productId).all();

  const totalOnHand = result.results.reduce(
    (sum, r) => sum + ((r as { on_hand: number }).on_hand ?? 0),
    0
  );

  return ok(c, {
    product,
    total_on_hand: totalOnHand,
    by_warehouse: result.results,
  });
});
