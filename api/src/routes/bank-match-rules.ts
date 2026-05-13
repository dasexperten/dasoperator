// =============================================================================
// /api/bank-match-rules — CRUD for auto-attach rules
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const bankMatchRules = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  partner_id: z.string().min(1),
  contragent_inn: z.string().nullable().optional(),
  purpose_pattern: z.string().nullable().optional(),
  direction: z.enum(['incoming', 'outgoing', 'any']).default('any'),
  default_operation_type: z.enum(['sale', 'purchase', 'transfer', 'bundling']),
  default_our_company_id: z.string().nullable().optional(),
  created_from_tx_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

// =============================================================================
// GET /api/bank-match-rules — list with partner JOIN
// =============================================================================
bankMatchRules.get('/', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.partner_id, r.contragent_inn, r.purpose_pattern,
              r.direction, r.default_operation_type, r.default_our_company_id,
              r.hit_count, r.last_hit_at, r.created_at, r.notes,
              p.trade_name AS partner_name, p.kind AS partner_kind,
              c.abbreviation AS company_abbreviation
         FROM bank_match_rules r
         LEFT JOIN partners p ON p.id = r.partner_id
         LEFT JOIN companies c ON c.id = r.default_our_company_id
        WHERE r.deleted_at IS NULL
        ORDER BY r.hit_count DESC, r.created_at DESC`
    ).all();
    return ok(c, { rules: rows.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-match-rules — create rule
// =============================================================================
bankMatchRules.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [{ code: 'validation', message: 'Invalid input', details: parsed.error.flatten() }]);
    }
    const d = parsed.data;
    const id = `bmr_${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      `INSERT INTO bank_match_rules
         (id, partner_id, contragent_inn, purpose_pattern, direction,
          default_operation_type, default_our_company_id, hit_count,
          created_at, updated_at, created_from_tx_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    ).bind(
      id,
      d.partner_id,
      d.contragent_inn ?? null,
      d.purpose_pattern ?? null,
      d.direction,
      d.default_operation_type,
      d.default_our_company_id ?? null,
      now, now,
      d.created_from_tx_id ?? null,
      d.notes ?? null
    ).run();

    const created = await c.env.DB.prepare(
      `SELECT r.*, p.trade_name AS partner_name
         FROM bank_match_rules r
         LEFT JOIN partners p ON p.id = r.partner_id
        WHERE r.id = ?`
    ).bind(id).first();

    return ok(c, { rule: created });
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
// POST /api/bank-match-rules/suggest — given tx + operation, ask Claude
// =============================================================================
// Body: { tx_id: string, operation_id: string }
// Returns: RuleSuggestion | null
// =============================================================================
bankMatchRules.post('/suggest', async (c) => {
  try {
    const body = (await c.req.json()) as { tx_id?: string; operation_id?: string };
    if (!body.tx_id || !body.operation_id) {
      return fail(c, 400, [{ code: 'missing_params', message: 'tx_id and operation_id required' }]);
    }

    const tx = await c.env.DB.prepare(
      `SELECT id, direction, amount, currency, contragent_name, contragent_inn, payment_purpose
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

    // Check if rule already exists for this partner+inn+pattern — don't suggest dup
    if (partner) {
      const dup = await c.env.DB.prepare(
        `SELECT id FROM bank_match_rules
          WHERE partner_id = ? AND deleted_at IS NULL`
      ).bind(partner.id).first();
      // If we already have a rule for this partner, still let suggest run but mark
      // (caller can decide). For now, just continue.
    }

    const { suggestRuleFromAssignment } = await import('../lib/bank-match-rules');
    const suggestion = await suggestRuleFromAssignment(c.env, {
      tx,
      operation: op,
      partner,
    });

    return ok(c, { suggestion });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default bankMatchRules;
