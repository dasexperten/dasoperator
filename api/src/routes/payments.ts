import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const payments = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  partner_id: z.string().min(1),
  contract_id: z.string().min(1),
  operation_id: z.string().nullable().optional(),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3),
  payment_date: z.number().int().positive(),
  type: z.enum(['advance', 'final', 'refund', 'partial']),
  direction: z.enum(['incoming', 'outgoing']),
  notes: z.string().nullable().optional(),
});

// =============================================================================
// GET /api/payments — list, filterable
// =============================================================================
payments.get('/', async (c) => {
  const partnerId = c.req.query('partner_id');
  const contractId = c.req.query('contract_id');
  const operationId = c.req.query('operation_id');

  let sql = `
    SELECT
      p.id, p.partner_id, prt.trade_name as partner_trade_name,
      p.contract_id, c.contract_no, c.currency as contract_currency,
      p.operation_id, p.amount, p.currency, p.payment_date,
      p.type, p.direction, p.notes, p.created_at, p.updated_at
    FROM payments p
    LEFT JOIN partners prt ON p.partner_id = prt.id
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE p.deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (partnerId) { sql += ` AND p.partner_id = ?`; binds.push(partnerId); }
  if (contractId) { sql += ` AND p.contract_id = ?`; binds.push(contractId); }
  if (operationId) { sql += ` AND p.operation_id = ?`; binds.push(operationId); }

  sql += ` ORDER BY p.payment_date DESC`;

  const stmt = c.env.DB.prepare(sql);
  const result = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();

  return ok(c, {
    count: result.results.length,
    payments: result.results,
  });
});

// =============================================================================
// GET /api/payments/:id
// =============================================================================
payments.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`
    SELECT p.*, prt.trade_name as partner_trade_name, c.contract_no
    FROM payments p
    LEFT JOIN partners prt ON p.partner_id = prt.id
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).bind(id).first();

  if (!row) {
    return fail(c, 404, [{ code: 'payment_not_found', message: `Payment ${id} not found` }]);
  }
  return ok(c, row);
});

// =============================================================================
// POST /api/payments
// =============================================================================
payments.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body', message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  // Verify partner + contract + operation existence
  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.partner_id).first();
  if (!partner) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `partner_id ${data.partner_id}` }]);
  }

  const contract = await c.env.DB.prepare(
    'SELECT id, partner_id, currency FROM contracts WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.contract_id).first<{ id: string; partner_id: string; currency: string }>();
  if (!contract) {
    return fail(c, 404, [{ code: 'contract_not_found', message: `contract_id ${data.contract_id}` }]);
  }
  if (contract.partner_id !== data.partner_id) {
    return fail(c, 400, [{
      code: 'contract_partner_mismatch',
      message: 'Contract does not belong to this partner',
    }]);
  }

  if (data.operation_id) {
    const op = await c.env.DB.prepare(
      'SELECT id, contract_id FROM operations WHERE id = ? AND deleted_at IS NULL'
    ).bind(data.operation_id).first<{ id: string; contract_id: string }>();
    if (!op) {
      return fail(c, 404, [{ code: 'operation_not_found', message: `operation_id ${data.operation_id}` }]);
    }
    if (op.contract_id !== data.contract_id) {
      return fail(c, 400, [{
        code: 'operation_contract_mismatch',
        message: 'Operation belongs to different contract',
      }]);
    }
  }

  const id = `pay_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(`
      INSERT INTO payments (
        id, partner_id, contract_id, operation_id, amount, currency,
        payment_date, type, direction, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, data.partner_id, data.contract_id, data.operation_id ?? null,
      data.amount, data.currency, data.payment_date, data.type, data.direction,
      data.notes ?? null, now, now
    ).run();
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed', message: 'Failed to create payment',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, { id, ...data, created_at: now, updated_at: now }, ['Payment created']);
});

export default payments;
