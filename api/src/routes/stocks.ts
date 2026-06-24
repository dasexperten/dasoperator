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

// =============================================================================
// POST /api/stocks/transfer — move stock between two warehouses of the SAME company
//
// Atomic-ish: validates ALL lines (same-company, sufficient on_hand) before
// applying any movement. Each line fires two movements sharing one transfer ref:
//   transfer_out (negative) @ from_warehouse  +  transfer_in (positive) @ to_warehouse
// Company total is unchanged by design.
// =============================================================================
const transferSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  lines: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().int().positive(),
  })).min(1),
  reason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  performed_by: z.string().nullable().optional(),
});

stocks.post('/transfer', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = transferSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }
  const data = parsed.data;

  if (data.from_warehouse_id === data.to_warehouse_id) {
    return fail(c, 422, [{ code: 'same_warehouse', message: 'from and to warehouses must differ' }]);
  }

  const from = await c.env.DB.prepare(
    'SELECT id, code, owner_company_id FROM warehouses WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.from_warehouse_id).first<{ id: string; code: string; owner_company_id: string | null }>();
  if (!from) return fail(c, 404, [{ code: 'warehouse_not_found', message: data.from_warehouse_id }]);

  const to = await c.env.DB.prepare(
    'SELECT id, code, owner_company_id FROM warehouses WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.to_warehouse_id).first<{ id: string; code: string; owner_company_id: string | null }>();
  if (!to) return fail(c, 404, [{ code: 'warehouse_not_found', message: data.to_warehouse_id }]);

  if (!from.owner_company_id || !to.owner_company_id || from.owner_company_id !== to.owner_company_id) {
    return fail(c, 422, [{
      code: 'company_mismatch',
      message: 'Both warehouses must belong to the same company',
      details: { from_company: from.owner_company_id, to_company: to.owner_company_id },
    }]);
  }

  const checked: Array<{ product_id: string; product_name: string; quantity: number; available: number }> = [];
  for (const line of data.lines) {
    const prod = await c.env.DB.prepare(
      'SELECT id, product_name FROM products WHERE id = ? AND deleted_at IS NULL'
    ).bind(line.product_id).first<{ id: string; product_name: string }>();
    if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: line.product_id }]);

    const cur = await c.env.DB.prepare(
      "SELECT on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ? AND stock_state = 'on_hand'"
    ).bind(data.from_warehouse_id, line.product_id).first<{ on_hand: number }>();
    const available = cur?.on_hand ?? 0;

    if (line.quantity > available) {
      return fail(c, 422, [{
        code: 'insufficient_stock',
        message: `${prod.product_name}: requested ${line.quantity}, available ${available} at ${from.code}`,
        details: { product_id: line.product_id, requested: line.quantity, available },
      }]);
    }
    checked.push({ product_id: line.product_id, product_name: prod.product_name, quantity: line.quantity, available });
  }

  const now = Math.floor(Date.now() / 1000);
  const d = new Date(now * 1000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const transferRef = `TRF-${ymd}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const baseReason = data.reason ?? `Stock transfer ${from.code} -> ${to.code}`;

  const results: Array<Record<string, unknown>> = [];
  try {
    for (const line of checked) {
      const outRes = await applyMovement(c.env.DB, {
        warehouse_id: data.from_warehouse_id,
        product_id: line.product_id,
        movement_type: 'transfer_out',
        quantity: -line.quantity,
        source: 'manual',
        source_ref_type: 'transfer',
        source_ref_id: transferRef,
        reason: baseReason,
        notes: data.notes ?? null,
        performed_by: data.performed_by ?? null,
        performed_at: now,
      });
      const inRes = await applyMovement(c.env.DB, {
        warehouse_id: data.to_warehouse_id,
        product_id: line.product_id,
        movement_type: 'transfer_in',
        quantity: line.quantity,
        source: 'manual',
        source_ref_type: 'transfer',
        source_ref_id: transferRef,
        reason: baseReason,
        notes: data.notes ?? null,
        performed_by: data.performed_by ?? null,
        performed_at: now,
      });
      results.push({
        product_id: line.product_id,
        product_name: line.product_name,
        quantity: line.quantity,
        from_balance_after: outRes.balance_after,
        to_balance_after: inRes.balance_after,
      });
    }
  } catch (err) {
    return fail(c, 500, [{
      code: 'transfer_failed',
      message: 'Transfer partially failed -- check stock movements journal',
      details: { transfer_ref: transferRef, error: err instanceof Error ? err.message : String(err), applied: results },
    }]);
  }

  return ok(c, {
    transfer_ref: transferRef,
    from_warehouse: { id: from.id, code: from.code },
    to_warehouse: { id: to.id, code: to.code },
    company_id: from.owner_company_id,
    lines: results,
  }, [`Transferred ${results.length} product(s) ${from.code} -> ${to.code} (${transferRef})`]);
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
