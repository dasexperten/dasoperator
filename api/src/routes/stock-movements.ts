import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { applyMovement, validateSign, type MovementInput } from '../lib/inventory';

const stockMovements = new Hono<{ Bindings: Env }>();

const MOVEMENT_TYPES = [
  'receipt', 'shipment', 'transfer_in', 'transfer_out',
  'adjustment', 'session_correction', 'sync_correction',
  'opening_balance', 'write_off', 'return',
] as const;

const MOVEMENT_SOURCES = [
  'manual', 'operation', 'session',
  'sync_wb', 'sync_ozon', 'sync_3pl', 'sync_api',
  'cron', 'opening',
] as const;

// =============================================================================
// GET /api/stock-movements — journal with filters
// Filters: warehouse_id, product_id, movement_type, source, source_ref_id,
//          date_from, date_to (unix), limit (default 100, max 1000)
// =============================================================================
stockMovements.get('/', async (c) => {
  const warehouseId = c.req.query('warehouse_id');
  const productId = c.req.query('product_id');
  const movementType = c.req.query('movement_type');
  const source = c.req.query('source');
  const sourceRefId = c.req.query('source_ref_id');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const limitRaw = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitRaw ?? '100', 10) || 100, 1), 1000);

  let sql = `
    SELECT
      m.id, m.warehouse_id, w.code,
      m.product_id, p.product_name, p.invoice_label,
      m.movement_type, m.quantity, m.balance_after,
      m.source, m.source_ref_type, m.source_ref_id,
      m.reason, m.notes, m.performed_by, m.performed_at, m.created_at
    FROM stock_movements m
    LEFT JOIN warehouses w ON m.warehouse_id = w.id
    LEFT JOIN products p ON m.product_id = p.id
    WHERE 1=1
  `;
  const binds: unknown[] = [];

  if (warehouseId) { sql += ` AND m.warehouse_id = ?`; binds.push(warehouseId); }
  if (productId) { sql += ` AND m.product_id = ?`; binds.push(productId); }
  if (movementType) { sql += ` AND m.movement_type = ?`; binds.push(movementType); }
  if (source) { sql += ` AND m.source = ?`; binds.push(source); }
  if (sourceRefId) { sql += ` AND m.source_ref_id = ?`; binds.push(sourceRefId); }
  if (dateFrom) { sql += ` AND m.performed_at >= ?`; binds.push(parseInt(dateFrom, 10)); }
  if (dateTo) { sql += ` AND m.performed_at <= ?`; binds.push(parseInt(dateTo, 10)); }

  sql += ` ORDER BY m.performed_at DESC, m.created_at DESC LIMIT ?`;
  binds.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...binds).all();

  return ok(c, {
    count: result.results.length,
    limit,
    movements: result.results,
  });
});

// =============================================================================
// POST /api/stock-movements — manual movement create
// Most common in MVP: receipt, shipment, write_off, opening_balance, adjustment
// For session corrections — use POST /api/inventory-sessions/:id/commit
// For operation-driven — auto-fired by PATCH /api/operations/:id/status (future)
// =============================================================================
const createMovementSchema = z.object({
  warehouse_id: z.string().min(1),
  product_id: z.string().min(1),
  movement_type: z.enum(MOVEMENT_TYPES),
  quantity: z.number().int(),
  source: z.enum(MOVEMENT_SOURCES).default('manual'),
  source_ref_type: z.string().nullable().optional(),
  source_ref_id: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  performed_by: z.string().nullable().optional(),
  performed_at: z.number().int().positive().optional(),
});

stockMovements.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = createMovementSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data as MovementInput;

  // Sign rule per movement_type
  const signError = validateSign(data);
  if (signError) {
    return fail(c, 422, [{ code: 'invalid_sign', message: signError }]);
  }

  // Verify warehouse + product
  const wh = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(data.warehouse_id).first();
  if (!wh) return fail(c, 404, [{ code: 'warehouse_not_found', message: data.warehouse_id }]);

  const prod = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').bind(data.product_id).first();
  if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: data.product_id }]);

  // Apply
  try {
    const result = await applyMovement(c.env.DB, data);
    return ok(c, result, [`Stock ${data.product_id} @ ${data.warehouse_id}: ${result.balance_after}`]);
  } catch (err) {
    return fail(c, 500, [{
      code: 'movement_failed', message: 'Failed to apply movement',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }
});

// =============================================================================
// GET /api/stock-movements/:id — single movement detail
// =============================================================================
stockMovements.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`
    SELECT
      m.*, w.code, w.name,
      p.product_name, p.invoice_label
    FROM stock_movements m
    LEFT JOIN warehouses w ON m.warehouse_id = w.id
    LEFT JOIN products p ON m.product_id = p.id
    WHERE m.id = ?
  `).bind(id).first();

  if (!row) return fail(c, 404, [{ code: 'movement_not_found', message: id }]);
  return ok(c, row);
});

export default stockMovements;
