import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const bundling = new Hono<{ Bindings: Env }>();

// =============================================================================
// Bundling item schema — one pack/unpack pair
// direction 'pack':   from_product_id units consumed → to_product_id units produced
// direction 'unpack': bundle consumed → singles produced
// =============================================================================

const bundlingItemSchema = z.object({
  from_product_id: z.string().min(1),
  to_product_id:   z.string().min(1),
  from_qty:        z.number().int().positive(),
  to_qty:          z.number().int().positive(),
  direction:       z.enum(['pack', 'unpack']),
});

const bundlingSchema = z.object({
  warehouse_id:  z.string().min(1),
  our_company_id: z.string().min(1),
  items:          z.array(bundlingItemSchema).min(1),
  notes:          z.string().optional(),
  operation_date: z.number().int().optional(),
});

// =============================================================================
// POST /api/bundling
// Creates a bundling operation + bundling_items rows + stock_movements atomically.
// Reference format: BND-001 (uses seq_bnd sequence).
// Status: goes directly to 'delivered' — bundling is immediate, not staged.
// Stock effect: immediate on create.
//   pack:   -from_qty from from_product, +to_qty on to_product (same warehouse)
//   unpack: -from_qty from from_product (bundle), +to_qty on to_product (singles)
// =============================================================================

bundling.post('/', async (c) => {
  const body = await c.req.json();
  const parsed = bundlingSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{ code: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Invalid input', details: parsed.error }]);
  }

  const { warehouse_id, our_company_id, items, notes, operation_date } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const opDate = operation_date ?? now;

  // Verify warehouse exists
  const wh = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(warehouse_id).first();
  if (!wh) return fail(c, 404, [{ code: 'warehouse_not_found', message: `Warehouse ${warehouse_id} not found` }]);

  // Verify company exists
  const co = await c.env.DB.prepare('SELECT id, abbreviation FROM companies WHERE id = ?').bind(our_company_id).first<{ id: string; abbreviation: string }>();
  if (!co) return fail(c, 404, [{ code: 'company_not_found', message: `Company ${our_company_id} not found` }]);

  // Verify all products exist
  for (const item of items) {
    const pf = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(item.from_product_id).first();
    const pt = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(item.to_product_id).first();
    if (!pf) return fail(c, 404, [{ code: 'product_not_found', message: `Product ${item.from_product_id} not found` }]);
    if (!pt) return fail(c, 404, [{ code: 'product_not_found', message: `Product ${item.to_product_id} not found` }]);
  }

  // Generate reference number BND-001
  const seqRow = await c.env.DB.prepare(
    'UPDATE sequences SET next_number = next_number + 1, updated_at = ? WHERE id = ? RETURNING next_number, padding'
  ).bind(now, 'seq_bnd').first<{ next_number: number; padding: number }>();
  if (!seqRow) return fail(c, 500, [{ code: 'sequence_error', message: 'Could not generate BND reference' }]);

  const refNum = String(seqRow.next_number - 1).padStart(seqRow.padding, '0');
  const reference = `BND-${refNum}`;

  const opId = `op_${crypto.randomUUID()}`;

  // Build batch: operation + bundling_items + stock movements (both sides per item)
  const batch: D1PreparedStatement[] = [];

  // 1. Create operation (no currency/amount — bundling is internal, no money)
  batch.push(
    c.env.DB.prepare(`
      INSERT INTO operations
        (id, operation_date, operation_type, our_company_id, warehouse_from_id,
         status, notes, reference, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(opId, opDate, 'bundling', our_company_id, warehouse_id,
            'delivered', notes ?? null, reference, now, now)
  );

  // 2. bundling_items + stock movements per pair
  for (const item of items) {
    const biId = `bi_${crypto.randomUUID()}`;
    const mvFromId = `mv_${crypto.randomUUID()}`;
    const mvToId   = `mv_${crypto.randomUUID()}`;

    batch.push(
      c.env.DB.prepare(`
        INSERT INTO bundling_items
          (id, operation_id, from_product_id, to_product_id, from_qty, to_qty, direction, warehouse_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(biId, opId, item.from_product_id, item.to_product_id,
              item.from_qty, item.to_qty, item.direction, warehouse_id, now)
    );

    // Stock movement: consume from_product (negative)
    batch.push(
      c.env.DB.prepare(`
        INSERT INTO stock_movements
          (id, warehouse_id, product_id, movement_type, quantity, source,
           source_ref_type, source_ref_id, reason, performed_at, balance_after, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,
          COALESCE((SELECT on_hand FROM stocks WHERE warehouse_id=? AND product_id=?), 0) - ?,
          ?)
      `).bind(
        mvFromId, warehouse_id, item.from_product_id,
        item.direction === 'pack' ? 'transfer_out' : 'shipment',
        -item.from_qty, 'operation', 'operation', opId,
        `Bundling ${reference} — consume ${item.from_product_id}`,
        now,
        warehouse_id, item.from_product_id, item.from_qty,
        now
      )
    );

    // Update stocks: from_product
    batch.push(
      c.env.DB.prepare(`
        INSERT INTO stocks (id, warehouse_id, product_id, on_hand, last_movement_at, updated_at)
        VALUES (?, ?, ?, -?, ?, ?)
        ON CONFLICT(warehouse_id, product_id) DO UPDATE SET
          on_hand = on_hand - ?,
          last_movement_at = ?,
          updated_at = ?
      `).bind(
        `st_${warehouse_id}_${item.from_product_id}`,
        warehouse_id, item.from_product_id, item.from_qty, now, now,
        item.from_qty, now, now
      )
    );

    // Stock movement: produce to_product (positive)
    batch.push(
      c.env.DB.prepare(`
        INSERT INTO stock_movements
          (id, warehouse_id, product_id, movement_type, quantity, source,
           source_ref_type, source_ref_id, reason, performed_at, balance_after, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,
          COALESCE((SELECT on_hand FROM stocks WHERE warehouse_id=? AND product_id=?), 0) + ?,
          ?)
      `).bind(
        mvToId, warehouse_id, item.to_product_id,
        item.direction === 'pack' ? 'transfer_in' : 'receipt',
        item.to_qty, 'operation', 'operation', opId,
        `Bundling ${reference} — produce ${item.to_product_id}`,
        now,
        warehouse_id, item.to_product_id, item.to_qty,
        now
      )
    );

    // Update stocks: to_product
    batch.push(
      c.env.DB.prepare(`
        INSERT INTO stocks (id, warehouse_id, product_id, on_hand, last_movement_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(warehouse_id, product_id) DO UPDATE SET
          on_hand = on_hand + ?,
          last_movement_at = ?,
          updated_at = ?
      `).bind(
        `st_${warehouse_id}_${item.to_product_id}`,
        warehouse_id, item.to_product_id, item.to_qty, now, now,
        item.to_qty, now, now
      )
    );
  }

  await c.env.DB.batch(batch);

  return ok(c, {
    id: opId,
    reference,
    warehouse_id,
    our_company_id,
    status: 'delivered',
    items_count: items.length,
  }, 201);
});

// =============================================================================
// GET /api/bundling — list bundling operations with items
// =============================================================================

bundling.get('/', async (c) => {
  const warehouseId  = c.req.query('warehouse_id');
  const companyId    = c.req.query('our_company_id');
  const limitRaw     = c.req.query('limit');
  const limit        = Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200);

  let sql = `
    SELECT o.id, o.reference, o.operation_date, o.warehouse_from_id, o.our_company_id,
           o.status, o.notes, o.created_at,
           co.abbreviation as entity_abbreviation,
           w.code as warehouse_code
    FROM operations o
    LEFT JOIN companies co ON o.our_company_id = co.id
    LEFT JOIN warehouses w ON o.warehouse_from_id = w.id
    WHERE o.operation_type = 'bundling' AND o.deleted_at IS NULL
  `;
  const binds: unknown[] = [];
  if (warehouseId) { sql += ' AND o.warehouse_from_id = ?'; binds.push(warehouseId); }
  if (companyId)   { sql += ' AND o.our_company_id = ?';   binds.push(companyId); }
  sql += ' ORDER BY o.created_at DESC LIMIT ?';
  binds.push(limit);

  const ops = await c.env.DB.prepare(sql).bind(...binds).all();

  return ok(c, { operations: ops.results, count: ops.results.length });
});

// =============================================================================
// GET /api/bundling/:id — single bundling operation with all items
// =============================================================================

bundling.get('/:id', async (c) => {
  const opId = c.req.param('id');

  const op = await c.env.DB.prepare(`
    SELECT o.*, co.abbreviation as entity_abbreviation, w.code as warehouse_code
    FROM operations o
    LEFT JOIN companies co ON o.our_company_id = co.id
    LEFT JOIN warehouses w ON o.warehouse_from_id = w.id
    WHERE o.id = ? AND o.operation_type = 'bundling' AND o.deleted_at IS NULL
  `).bind(opId).first();

  if (!op) return fail(c, 404, [{ code: 'not_found', message: `Bundling ${opId} not found` }]);

  const items = await c.env.DB.prepare(`
    SELECT bi.*,
           pf.product_name as from_name, pf.invoice_label as from_label,
           pt.product_name as to_name,   pt.invoice_label as to_label
    FROM bundling_items bi
    LEFT JOIN products pf ON bi.from_product_id = pf.id
    LEFT JOIN products pt ON bi.to_product_id   = pt.id
    WHERE bi.operation_id = ?
    ORDER BY bi.created_at ASC
  `).bind(opId).all();

  return ok(c, { operation: op, items: items.results });
});

export default bundling;
