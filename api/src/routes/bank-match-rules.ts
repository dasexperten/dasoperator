// =============================================================================
// /api/bank-match-rules — CRUD for transaction classification rules
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const bankMatchRules = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  category_id: z.string().min(1, 'category_id is required'),
  contragent_inn: z.string().nullable().optional(),
  contragent_iban: z.string().nullable().optional(),
  purpose_pattern: z.string().nullable().optional(),
  direction: z.enum(['incoming', 'outgoing', 'any']).default('any'),
  partner_id: z.string().nullable().optional(),
  default_our_company_id: z.string().nullable().optional(),
  default_operation_type: z.enum(['sale', 'purchase', 'transfer', 'bundling']).optional(),
  created_from_tx_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
}).refine(
  (d) => d.contragent_inn || d.contragent_iban || d.purpose_pattern,
  { message: 'At least one of contragent_inn, contragent_iban, or purpose_pattern is required' }
);

const updateSchema = z.object({
  category_id: z.string().optional(),
  contragent_inn: z.string().nullable().optional(),
  contragent_iban: z.string().nullable().optional(),
  purpose_pattern: z.string().nullable().optional(),
  direction: z.enum(['incoming', 'outgoing', 'any']).optional(),
  partner_id: z.string().nullable().optional(),
  default_our_company_id: z.string().nullable().optional(),
  default_operation_type: z.enum(['sale', 'purchase', 'transfer', 'bundling']).optional(),
  notes: z.string().nullable().optional(),
});

// =============================================================================
// GET /api/bank-match-rules — list with category + partner JOINs
// =============================================================================
bankMatchRules.get('/', async (c) => {
  try {
    const categoryFilter = c.req.query('category_id');
    let where = 'WHERE r.deleted_at IS NULL';
    const params: any[] = [];
    if (categoryFilter) {
      where += ' AND r.category_id = ?';
      params.push(categoryFilter);
    }

    const rows = await c.env.DB.prepare(
      `SELECT r.*,
              fc.label AS category_label, fc.color AS category_color, fc.icon AS category_icon,
              fc.always_confirm AS category_always_confirm,
              p.trade_name AS partner_name, p.kind AS partner_kind,
              comp.abbreviation AS company_abbreviation
         FROM bank_match_rules r
         LEFT JOIN finance_categories fc ON fc.id = r.category_id
         LEFT JOIN partners p ON p.id = r.partner_id
         LEFT JOIN companies comp ON comp.id = r.default_our_company_id
        ${where}
        ORDER BY r.hit_count DESC, r.created_at DESC`
    ).bind(...params).all();

    return ok(c, { rules: rows.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-match-rules — create
// =============================================================================
bankMatchRules.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [{ code: 'validation', message: 'Invalid input', details: parsed.error.flatten() }]);
    }
    const d = parsed.data;

    // Verify category exists
    const cat = await c.env.DB.prepare(
      `SELECT id, default_operation_type FROM finance_categories WHERE id = ? AND deleted_at IS NULL`
    ).bind(d.category_id).first<{ id: string; default_operation_type: string }>();
    if (!cat) return fail(c, 404, [{ code: 'category_not_found', message: `Category ${d.category_id} not found` }]);

    const id = `bmr_${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const opType = d.default_operation_type ?? cat.default_operation_type;

    await c.env.DB.prepare(
      `INSERT INTO bank_match_rules
         (id, category_id, partner_id, contragent_inn, contragent_iban,
          purpose_pattern, direction, default_operation_type,
          default_our_company_id, hit_count, created_at, updated_at,
          created_from_tx_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).bind(
      id, d.category_id, d.partner_id ?? null,
      d.contragent_inn ?? null, d.contragent_iban ?? null,
      d.purpose_pattern ?? null, d.direction, opType,
      d.default_our_company_id ?? null,
      now, now,
      d.created_from_tx_id ?? null, d.notes ?? null
    ).run();

    const created = await c.env.DB.prepare(
      `SELECT r.*, fc.label AS category_label, p.trade_name AS partner_name
         FROM bank_match_rules r
         LEFT JOIN finance_categories fc ON fc.id = r.category_id
         LEFT JOIN partners p ON p.id = r.partner_id
        WHERE r.id = ?`
    ).bind(id).first();

    return ok(c, { rule: created });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /api/bank-match-rules/:id
// =============================================================================
bankMatchRules.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [{ code: 'validation', message: 'Invalid input', details: parsed.error.flatten() }]);
    }
    const d = parsed.data;

    const existing = await c.env.DB.prepare(
      `SELECT id FROM bank_match_rules WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first();
    if (!existing) return fail(c, 404, [{ code: 'not_found', message: `Rule ${id} not found` }]);

    const updates: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) {
        updates.push(`${k} = ?`);
        params.push(v);
      }
    }
    if (updates.length === 0) return fail(c, 422, [{ code: 'no_changes', message: 'No fields to update' }]);

    updates.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(id);

    await c.env.DB.prepare(
      `UPDATE bank_match_rules SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    return ok(c, { id });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// DELETE /api/bank-match-rules/:id — soft delete
// =============================================================================
bankMatchRules.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE bank_match_rules SET deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now, now, id).run();
    return ok(c, { id, deleted: true });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-match-rules/preview — what would rules say for this tx?
// Body: { tx_id } or { contragent_inn, payment_purpose, direction, contragent_iban? }
// Returns: ClassificationResult + ClassifyDecision
// =============================================================================
bankMatchRules.post('/preview', async (c) => {
  try {
    const body = (await c.req.json()) as {
      tx_id?: string;
      contragent_inn?: string;
      contragent_iban?: string;
      contragent_account?: string;
      payment_purpose?: string;
      direction?: 'incoming' | 'outgoing';
    };

    let tx: any;
    if (body.tx_id) {
      tx = await c.env.DB.prepare(
        `SELECT contragent_inn, contragent_account, contragent_name, payment_purpose, direction
           FROM bank_transactions WHERE id = ?`
      ).bind(body.tx_id).first();
      if (!tx) return fail(c, 404, [{ code: 'tx_not_found', message: `Tx ${body.tx_id} not found` }]);
    } else {
      tx = {
        contragent_inn: body.contragent_inn || null,
        contragent_account: body.contragent_iban || body.contragent_account || null,
        contragent_name: null,
        payment_purpose: body.payment_purpose || null,
        direction: body.direction || 'outgoing',
      };
    }

    const { classifyTransaction, decideAction } = await import('../lib/transaction-classifier');
    const result = await classifyTransaction(c.env, tx);
    const decision = decideAction(result);

    let category: any = null;
    if (decision.category_id) {
      category = await c.env.DB.prepare(
        `SELECT id, code, label, color, icon, always_confirm FROM finance_categories WHERE id = ?`
      ).bind(decision.category_id).first();
    }

    return ok(c, { result, decision, category });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-match-rules/suggest — Claude suggests rule after manual assign
// Body: { tx_id, operation_id, category_id }
// =============================================================================
bankMatchRules.post('/suggest', async (c) => {
  try {
    const body = (await c.req.json()) as { tx_id?: string; operation_id?: string; category_id?: string };
    if (!body.tx_id || !body.operation_id) {
      return fail(c, 400, [{ code: 'missing_params', message: 'tx_id and operation_id required' }]);
    }

    const tx = await c.env.DB.prepare(
      `SELECT id, direction, amount, currency, contragent_name, contragent_inn,
              contragent_account, payment_purpose
         FROM bank_transactions WHERE id = ?`
    ).bind(body.tx_id).first<any>();
    if (!tx) return fail(c, 404, [{ code: 'tx_not_found', message: `Tx ${body.tx_id} not found` }]);

    const op = await c.env.DB.prepare(
      `SELECT id, reference, operation_type, partner_id, our_company_id
         FROM operations WHERE id = ?`
    ).bind(body.operation_id).first<any>();
    if (!op) return fail(c, 404, [{ code: 'op_not_found', message: `Operation ${body.operation_id} not found` }]);

    let partner: any = null;
    if (op.partner_id) {
      partner = await c.env.DB.prepare(
        `SELECT id, trade_name, kind FROM partners WHERE id = ?`
      ).bind(op.partner_id).first();
    }

    const { suggestRuleFromAssignment } = await import('../lib/bank-match-rules');
    const suggestion = await suggestRuleFromAssignment(c.env, {
      tx,
      operation: op,
      partner,
    });

    // Inject category_id if user passed one
    if (suggestion && body.category_id) {
      (suggestion as any).category_id = body.category_id;
    }

    return ok(c, { suggestion });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default bankMatchRules;
