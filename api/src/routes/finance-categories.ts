// =============================================================================
// /api/finance-categories — managed category list
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const financeCategories = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  code: z.string().min(2).max(50).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits, underscore only'),
  label: z.string().min(2).max(100),
  description: z.string().max(500).nullable().optional(),
  direction: z.enum(['incoming', 'outgoing', 'any']).default('any'),
  default_operation_type: z.enum(['sale', 'purchase', 'transfer', 'bundling']),
  default_partner_kind: z.string().nullable().optional(),
  always_confirm: z.boolean().default(false),
  sort_order: z.number().int().default(100),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ code: true });

// =============================================================================
// GET /api/finance-categories — list all (with optional ?include_deleted=1)
// =============================================================================
financeCategories.get('/', async (c) => {
  try {
    const includeDeleted = c.req.query('include_deleted') === '1';
    const sql = includeDeleted
      ? `SELECT * FROM finance_categories ORDER BY sort_order ASC, label ASC`
      : `SELECT * FROM finance_categories WHERE deleted_at IS NULL ORDER BY sort_order ASC, label ASC`;

    // Fetch all 3 datasets in parallel (instead of N+1 loop with 2 queries per category).
    // For 18 categories this drops 37 sequential queries → 3 parallel queries.
    const [catsResp, rulesResp, txResp] = await Promise.all([
      c.env.DB.prepare(sql).all(),
      c.env.DB.prepare(
        `SELECT category_id, COUNT(*) AS n
           FROM bank_match_rules
          WHERE deleted_at IS NULL AND category_id IS NOT NULL
          GROUP BY category_id`
      ).all<{ category_id: string; n: number }>(),
      c.env.DB.prepare(
        `SELECT suggested_category_id AS category_id, COUNT(*) AS n
           FROM bank_transactions
          WHERE deleted_at IS NULL AND suggested_category_id IS NOT NULL
          GROUP BY suggested_category_id`
      ).all<{ category_id: string; n: number }>(),
    ]);

    const ruleMap = new Map<string, number>();
    for (const r of rulesResp.results ?? []) ruleMap.set(r.category_id, r.n);
    const txMap = new Map<string, number>();
    for (const r of txResp.results ?? []) txMap.set(r.category_id, r.n);

    const cats = (catsResp.results ?? []) as Array<{ id: string; [key: string]: any }>;
    for (const cat of cats) {
      cat.rule_count = ruleMap.get(cat.id) ?? 0;
      cat.tx_count = txMap.get(cat.id) ?? 0;
    }

    return ok(c, { categories: cats });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// GET /api/finance-categories/:id
// =============================================================================
financeCategories.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT * FROM finance_categories WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first();
    if (!row) return fail(c, 404, [{ code: 'not_found', message: `Category ${id} not found` }]);
    return ok(c, { category: row });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/finance-categories — create
// =============================================================================
financeCategories.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [{ code: 'validation', message: 'Invalid input', details: parsed.error.flatten() }]);
    }
    const d = parsed.data;
    const id = `fc_${d.code}`;
    const now = Math.floor(Date.now() / 1000);

    const existing = await c.env.DB.prepare(
      `SELECT id FROM finance_categories WHERE code = ? AND deleted_at IS NULL`
    ).bind(d.code).first();
    if (existing) {
      return fail(c, 409, [{ code: 'duplicate_code', message: `Category code "${d.code}" already exists` }]);
    }

    await c.env.DB.prepare(
      `INSERT INTO finance_categories
         (id, code, label, description, direction, default_operation_type,
          default_partner_kind, always_confirm, sort_order, color, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, d.code, d.label, d.description ?? null,
      d.direction, d.default_operation_type,
      d.default_partner_kind ?? null,
      d.always_confirm ? 1 : 0,
      d.sort_order, d.color ?? null, d.icon ?? null,
      now, now
    ).run();

    const created = await c.env.DB.prepare(`SELECT * FROM finance_categories WHERE id = ?`).bind(id).first();
    return ok(c, { category: created });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /api/finance-categories/:id — update
// =============================================================================
financeCategories.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [{ code: 'validation', message: 'Invalid input', details: parsed.error.flatten() }]);
    }
    const d = parsed.data;

    const existing = await c.env.DB.prepare(`SELECT id FROM finance_categories WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
    if (!existing) return fail(c, 404, [{ code: 'not_found', message: `Category ${id} not found` }]);

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    const map: Record<string, any> = {
      label: d.label, description: d.description,
      direction: d.direction, default_operation_type: d.default_operation_type,
      default_partner_kind: d.default_partner_kind,
      always_confirm: d.always_confirm === undefined ? undefined : (d.always_confirm ? 1 : 0),
      sort_order: d.sort_order, color: d.color, icon: d.icon,
    };
    for (const [k, v] of Object.entries(map)) {
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
      `UPDATE finance_categories SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    const updated = await c.env.DB.prepare(`SELECT * FROM finance_categories WHERE id = ?`).bind(id).first();
    return ok(c, { category: updated });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// DELETE /api/finance-categories/:id — soft delete + clear refs
// =============================================================================
financeCategories.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const now = Math.floor(Date.now() / 1000);

    // Soft-delete the category
    await c.env.DB.prepare(
      `UPDATE finance_categories SET deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now, now, id).run();

    // Clear category_id from related rows (FK is ON DELETE SET NULL but soft delete needs manual clear)
    await c.env.DB.prepare(
      `UPDATE bank_match_rules SET category_id = NULL, updated_at = ? WHERE category_id = ?`
    ).bind(now, id).run();
    await c.env.DB.prepare(
      `UPDATE bank_transactions SET suggested_category_id = NULL, updated_at = ? WHERE suggested_category_id = ?`
    ).bind(now, id).run();

    return ok(c, { id, deleted: true });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default financeCategories;
