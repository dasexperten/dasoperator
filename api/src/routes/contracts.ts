import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const contracts = new Hono<{ Bindings: Env }>();

// =============================================================================
// Schemas
// =============================================================================

const createSchema = z.object({
  contract_no: z.string().min(1).max(100),
  partner_id: z.string().min(1),
  our_company_id: z.string().min(1),
  currency: z.string().min(3).max(3),
  signed_date: z.number().int().positive().optional(),
  expiry_date: z.number().int().positive().optional(),
  incoterms: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'expired', 'cancelled']).default('active'),
  notes: z.string().nullable().optional(),
  vat_rate: z.union([z.literal(0), z.literal(5), z.literal(20)]).default(0),
});

function genContractId(contractNo: string): string {
  const slug = contractNo.toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `ctr_${slug}`;
}

// =============================================================================
// GET /api/contracts — list all with JOINs
// =============================================================================
contracts.get('/', async (c) => {
  const sql = `
    SELECT
      c.id, c.contract_no, c.partner_id, p.trade_name as partner_trade_name,
      c.our_company_id, co.abbreviation as entity_abbreviation,
      c.currency, c.signed_date, c.expiry_date, c.incoterms,
      c.status, c.notes, c.vat_rate, c.created_at, c.updated_at
    FROM contracts c
    LEFT JOIN partners p ON c.partner_id = p.id
    LEFT JOIN companies co ON c.our_company_id = co.id
    WHERE c.deleted_at IS NULL
    ORDER BY c.contract_no
  `;
  const result = await c.env.DB.prepare(sql).all();
  return ok(c, {
    count: result.results.length,
    contracts: result.results,
  });
});

// =============================================================================
// GET /api/contracts/:id
// =============================================================================
contracts.get('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`
    SELECT
      c.*, p.trade_name as partner_trade_name,
      co.abbreviation as entity_abbreviation
    FROM contracts c
    LEFT JOIN partners p ON c.partner_id = p.id
    LEFT JOIN companies co ON c.our_company_id = co.id
    WHERE c.id = ? AND c.deleted_at IS NULL
  `).bind(id).first();

  if (!row) {
    return fail(c, 404, [{
      code: 'contract_not_found',
      message: `Contract ${id} not found`,
    }]);
  }
  return ok(c, row);
});

// =============================================================================
// POST /api/contracts — create new
// =============================================================================
contracts.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;

  // Verify partner exists
  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.partner_id).first();

  if (!partner) {
    return fail(c, 404, [{
      code: 'partner_not_found',
      message: `partner_id ${data.partner_id} does not exist`,
    }]);
  }

  // Verify company exists
  const company = await c.env.DB.prepare(
    'SELECT id FROM companies WHERE id = ?'
  ).bind(data.our_company_id).first();

  if (!company) {
    return fail(c, 404, [{
      code: 'company_not_found',
      message: `our_company_id ${data.our_company_id} does not exist`,
    }]);
  }

  const id = genContractId(data.contract_no);
  const now = Math.floor(Date.now() / 1000);

  try {
    await c.env.DB.prepare(`
      INSERT INTO contracts (
        id, contract_no, partner_id, our_company_id, currency,
        signed_date, expiry_date, incoterms, status, notes, vat_rate,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, data.contract_no, data.partner_id, data.our_company_id, data.currency,
      data.signed_date ?? null, data.expiry_date ?? null,
      data.incoterms ?? null, data.status, data.notes ?? null, data.vat_rate,
      now, now
    ).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      return fail(c, 409, [{
        code: 'contract_no_exists',
        message: `Contract number ${data.contract_no} already exists`,
      }]);
    }
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to create contract',
      details: { error: message },
    }]);
  }

  return ok(c, {
    id, contract_no: data.contract_no, partner_id: data.partner_id,
    our_company_id: data.our_company_id, currency: data.currency,
    status: data.status, vat_rate: data.vat_rate,
    created_at: now, updated_at: now,
  }, ['Contract created']);
});

export default contracts;
