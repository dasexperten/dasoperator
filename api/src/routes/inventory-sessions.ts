import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueNextSequence } from '../lib/sequence-format';
import { applyMovement } from '../lib/inventory';

const inventorySessions = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/inventory-sessions — list, filter by warehouse_id, status
// =============================================================================
inventorySessions.get('/', async (c) => {
  const warehouseId = c.req.query('warehouse_id');
  const status = c.req.query('status');

  let sql = `
    SELECT
      s.id, s.reference, s.warehouse_id, w.code, w.name,
      s.status, s.scope,
      s.started_at, s.started_by,
      s.committed_at, s.committed_by,
      s.cancelled_at, s.cancelled_by,
      s.notes, s.total_lines, s.total_discrepancies,
      s.created_at, s.updated_at
    FROM inventory_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE 1=1
  `;
  const binds: unknown[] = [];
  if (warehouseId) { sql += ` AND s.warehouse_id = ?`; binds.push(warehouseId); }
  if (status) { sql += ` AND s.status = ?`; binds.push(status); }

  sql += ` ORDER BY s.started_at DESC`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    sessions: result.results,
  });
});

// =============================================================================
// GET /api/inventory-sessions/:id — detail with all session_lines
// =============================================================================
inventorySessions.get('/:id', async (c) => {
  const id = c.req.param('id');

  const session = await c.env.DB.prepare(`
    SELECT
      s.*, w.code, w.name
    FROM inventory_sessions s
    LEFT JOIN warehouses w ON s.warehouse_id = w.id
    WHERE s.id = ?
  `).bind(id).first();

  if (!session) return fail(c, 404, [{ code: 'session_not_found', message: id }]);

  const lines = await c.env.DB.prepare(`
    SELECT
      l.id, l.product_id, p.product_name, p.invoice_label, p.pieces_per_case,
      l.system_qty, l.counted_qty, l.counted_cases, l.counted_pieces,
      l.discrepancy, l.reason,
      l.counted_at, l.counted_by, l.notes,
      l.created_at, l.updated_at
    FROM session_lines l
    LEFT JOIN products p ON l.product_id = p.id
    WHERE l.session_id = ?
    ORDER BY p.product_name
  `).bind(id).all();

  return ok(c, {
    session,
    lines: lines.results,
  });
});

// =============================================================================
// POST /api/inventory-sessions — start a new session
// =============================================================================
const createSessionSchema = z.object({
  warehouse_id: z.string().min(1),
  scope: z.enum(['full', 'partial', 'spot']).default('full'),
  notes: z.string().nullable().optional(),
  started_by: z.string().nullable().optional(),
});

inventorySessions.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  // Verify warehouse
  const wh = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(data.warehouse_id).first();
  if (!wh) return fail(c, 404, [{ code: 'warehouse_not_found', message: data.warehouse_id }]);

  // Issue reference INV-YYYYMM-NNNN
  const seq = await issueNextSequence(c.env.DB, 'inv');
  if (!seq) {
    return fail(c, 500, [{ code: 'sequence_failed', message: 'Failed to issue seq_inv' }]);
  }

  const sessionId = `ses_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(`
      INSERT INTO inventory_sessions (
        id, reference, warehouse_id, status, scope,
        started_at, started_by, notes,
        total_lines, total_discrepancies,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, 0, 0, ?, ?)
    `).bind(
      sessionId, seq.formatted, data.warehouse_id, data.scope,
      now, data.started_by ?? null, data.notes ?? null,
      now, now
    ).run();
  } catch (err) {
    return fail(c, 500, [{
      code: 'session_create_failed', message: 'Failed to create session',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    id: sessionId,
    reference: seq.formatted,
    warehouse_id: data.warehouse_id,
    status: 'open',
    scope: data.scope,
    started_at: now,
    started_by: data.started_by ?? null,
  });
});

// =============================================================================
// POST /api/inventory-sessions/:id/lines — add SKU to session
// Snapshots current stocks.on_hand into system_qty
// =============================================================================
const addLineSchema = z.object({
  product_id: z.string().min(1),
});

inventorySessions.post('/:id/lines', async (c) => {
  const sessionId = c.req.param('id');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = addLineSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  // Verify session is open or counting
  const session = await c.env.DB.prepare(
    'SELECT id, warehouse_id, status FROM inventory_sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; warehouse_id: string; status: string }>();

  if (!session) return fail(c, 404, [{ code: 'session_not_found', message: sessionId }]);
  if (session.status !== 'open' && session.status !== 'counting') {
    return fail(c, 400, [{
      code: 'session_not_writable',
      message: `Session is ${session.status}; lines can only be added to open/counting sessions`,
    }]);
  }

  const productId = parsed.data.product_id;

  // Verify product
  const prod = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').bind(productId).first();
  if (!prod) return fail(c, 404, [{ code: 'product_not_found', message: productId }]);

  // Snapshot system_qty from stocks
  const stockRow = await c.env.DB.prepare(
    'SELECT on_hand FROM stocks WHERE warehouse_id = ? AND product_id = ?'
  ).bind(session.warehouse_id, productId).first<{ on_hand: number }>();
  const systemQty = stockRow?.on_hand ?? 0;

  const lineId = `sl_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(`
      INSERT INTO session_lines (
        id, session_id, product_id, system_qty,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(lineId, sessionId, productId, systemQty, now, now).run();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('UNIQUE')) {
      return fail(c, 409, [{
        code: 'line_already_exists',
        message: `Line for ${productId} already in session`,
      }]);
    }
    return fail(c, 500, [{
      code: 'line_create_failed', message: 'Failed to create line',
      details: { error: errMsg },
    }]);
  }

  // Bump session status to 'counting' if was 'open'
  if (session.status === 'open') {
    await c.env.DB.prepare(
      "UPDATE inventory_sessions SET status = 'counting', updated_at = ? WHERE id = ?"
    ).bind(now, sessionId).run();
  }

  // Update total_lines counter
  await c.env.DB.prepare(
    'UPDATE inventory_sessions SET total_lines = total_lines + 1, updated_at = ? WHERE id = ?'
  ).bind(now, sessionId).run();

  return ok(c, {
    id: lineId,
    session_id: sessionId,
    product_id: productId,
    system_qty: systemQty,
    counted_qty: null,
  });
});

// =============================================================================
// PATCH /api/inventory-sessions/:id/lines/:lineId — set counted quantity
// Body: { counted_qty, counted_cases?, counted_pieces?, reason?, counted_by? }
// =============================================================================
const countLineSchema = z.object({
  counted_qty: z.number().int().nonnegative(),
  counted_cases: z.number().int().nonnegative().nullable().optional(),
  counted_pieces: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  counted_by: z.string().nullable().optional(),
});

inventorySessions.patch('/:id/lines/:lineId', async (c) => {
  const sessionId = c.req.param('id');
  const lineId = c.req.param('lineId');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = countLineSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  // Verify session is writable
  const session = await c.env.DB.prepare(
    'SELECT id, status FROM inventory_sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; status: string }>();

  if (!session) return fail(c, 404, [{ code: 'session_not_found', message: sessionId }]);
  if (session.status !== 'open' && session.status !== 'counting') {
    return fail(c, 400, [{
      code: 'session_not_writable',
      message: `Session is ${session.status}; counts can only be entered on open/counting sessions`,
    }]);
  }

  const line = await c.env.DB.prepare(
    'SELECT id, session_id FROM session_lines WHERE id = ? AND session_id = ?'
  ).bind(lineId, sessionId).first();
  if (!line) return fail(c, 404, [{ code: 'line_not_found', message: `${sessionId}/${lineId}` }]);

  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(`
    UPDATE session_lines
    SET counted_qty = ?,
        counted_cases = ?,
        counted_pieces = ?,
        reason = ?,
        notes = ?,
        counted_at = ?,
        counted_by = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    data.counted_qty,
    data.counted_cases ?? null,
    data.counted_pieces ?? null,
    data.reason ?? null,
    data.notes ?? null,
    now,
    data.counted_by ?? null,
    now,
    lineId
  ).run();

  return ok(c, {
    id: lineId,
    session_id: sessionId,
    counted_qty: data.counted_qty,
    counted_cases: data.counted_cases ?? null,
    counted_pieces: data.counted_pieces ?? null,
    counted_at: now,
    counted_by: data.counted_by ?? null,
  });
});

// =============================================================================
// POST /api/inventory-sessions/:id/commit — apply discrepancies to stocks
// Trust the count: each line where counted_qty !== system_qty creates
// a session_correction movement. Status → 'committed'.
// =============================================================================
const commitSchema = z.object({
  committed_by: z.string().nullable().optional(),
});

inventorySessions.post('/:id/commit', async (c) => {
  const sessionId = c.req.param('id');

  let body: unknown = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }

  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const session = await c.env.DB.prepare(
    'SELECT id, warehouse_id, status FROM inventory_sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; warehouse_id: string; status: string }>();

  if (!session) return fail(c, 404, [{ code: 'session_not_found', message: sessionId }]);
  if (session.status === 'committed') {
    return fail(c, 400, [{ code: 'already_committed', message: 'Session already committed' }]);
  }
  if (session.status === 'cancelled') {
    return fail(c, 400, [{ code: 'cancelled_session', message: 'Cannot commit cancelled session' }]);
  }

  // Load all lines that have counted_qty (skip uncounted)
  const linesResult = await c.env.DB.prepare(`
    SELECT id, product_id, system_qty, counted_qty
    FROM session_lines
    WHERE session_id = ? AND counted_qty IS NOT NULL
  `).bind(sessionId).all<{
    id: string;
    product_id: string;
    system_qty: number;
    counted_qty: number;
  }>();

  const lines = linesResult.results;
  let discrepancyCount = 0;
  const movementsCreated: Array<{ line_id: string; movement_id: string; delta: number }> = [];
  const errors: Array<{ line_id: string; error: string }> = [];

  for (const line of lines) {
    const delta = line.counted_qty - line.system_qty;

    // Always update line.discrepancy field, even if zero
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      'UPDATE session_lines SET discrepancy = ?, updated_at = ? WHERE id = ?'
    ).bind(delta, now, line.id).run();

    if (delta === 0) continue;
    discrepancyCount++;

    try {
      const result = await applyMovement(c.env.DB, {
        warehouse_id: session.warehouse_id,
        product_id: line.product_id,
        movement_type: 'session_correction',
        quantity: delta,
        source: 'session',
        source_ref_type: 'session',
        source_ref_id: sessionId,
        reason: `session ${sessionId}: counted ${line.counted_qty} vs system ${line.system_qty}`,
        performed_by: parsed.data.committed_by ?? null,
      });
      movementsCreated.push({
        line_id: line.id,
        movement_id: result.movement_id,
        delta,
      });
    } catch (err) {
      errors.push({
        line_id: line.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mark session committed (even with errors — partial commit)
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    UPDATE inventory_sessions
    SET status = 'committed',
        committed_at = ?,
        committed_by = ?,
        total_discrepancies = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(now, parsed.data.committed_by ?? null, discrepancyCount, now, sessionId).run();

  return ok(c, {
    session_id: sessionId,
    status: 'committed',
    committed_at: now,
    lines_processed: lines.length,
    discrepancies: discrepancyCount,
    movements: movementsCreated,
    errors: errors.length > 0 ? errors : undefined,
  }, errors.length > 0 ? [`Commit completed with ${errors.length} error(s)`] : undefined);
});

// =============================================================================
// POST /api/inventory-sessions/:id/cancel — abort without applying
// =============================================================================
const cancelSchema = z.object({
  cancelled_by: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

inventorySessions.post('/:id/cancel', async (c) => {
  const sessionId = c.req.param('id');

  let body: unknown = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }

  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const session = await c.env.DB.prepare(
    'SELECT id, status, notes FROM inventory_sessions WHERE id = ?'
  ).bind(sessionId).first<{ id: string; status: string; notes: string | null }>();

  if (!session) return fail(c, 404, [{ code: 'session_not_found', message: sessionId }]);
  if (session.status === 'committed') {
    return fail(c, 400, [{ code: 'already_committed', message: 'Cannot cancel committed session' }]);
  }
  if (session.status === 'cancelled') {
    return fail(c, 400, [{ code: 'already_cancelled', message: 'Already cancelled' }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const newNotes = parsed.data.reason
    ? (session.notes ? `${session.notes}\n[cancelled] ${parsed.data.reason}` : `[cancelled] ${parsed.data.reason}`)
    : session.notes;

  await c.env.DB.prepare(`
    UPDATE inventory_sessions
    SET status = 'cancelled',
        cancelled_at = ?,
        cancelled_by = ?,
        notes = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(now, parsed.data.cancelled_by ?? null, newNotes, now, sessionId).run();

  return ok(c, {
    id: sessionId,
    status: 'cancelled',
    cancelled_at: now,
    cancelled_by: parsed.data.cancelled_by ?? null,
  });
});

export default inventorySessions;
