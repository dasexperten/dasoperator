import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const bankStatementSources = new Hono<{ Bindings: Env }>();

function normalizeTelegramAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const urlMatch = v.match(/^(?:https?:\/\/)?t\.me\/(.+)$/i);
  if (urlMatch) {
    const path = urlMatch[1].replace(/^\/+|\/+$/g, '');
    const priv = path.match(/^c\/(\d{5,})(?:\/.*)?$/);
    if (priv) return `-100${priv[1]}`;
    const pub = path.match(/^([A-Za-z][A-Za-z0-9_]{3,31})(?:\/.*)?$/);
    if (pub) return `@${pub[1]}`;
    return null;
  }
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v)) return v;
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v)) return `@${v}`;
  if (/^\+\d{6,15}$/.test(v)) return v;
  if (/^-100\d{5,}$/.test(v)) return v;
  if (/^\d{5,}$/.test(v)) return `-100${v}`;
  return null;
}

const createSchema = z.discriminatedUnion('source_type', [
  z.object({
    source_type: z.literal('email_inbox'),
    address: z.string().email().toLowerCase().trim(),
    company_id: z.enum(['dee', 'dei', 'dasean', 'dec']),
    notes: z.string().optional(),
  }),
  z.object({
    source_type: z.literal('telegram_contact'),
    address: z.string().trim().transform((v, ctx) => {
      const n = normalizeTelegramAddress(v);
      if (!n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Use @username, +phone, t.me link, or -100<id> for a private group',
        });
        return z.NEVER;
      }
      return n;
    }),
    company_id: z.enum(['dee', 'dei', 'dasean', 'dec']),
    notes: z.string().optional(),
  }),
]);

const updateSchema = z.object({
  email: z.string().email().toLowerCase().trim().optional(),
  company_id: z.enum(['dee', 'dei', 'dasean', 'dec']).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().optional(),
});

// =============================================================================
// GET /api/bank-statement-sources — list all active sources
// =============================================================================
bankStatementSources.get('/', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.source_type, s.address, s.email, s.company_id, c.abbreviation AS company_abbreviation,
              c.legal_name AS company_legal_name, s.is_active, s.notes,
              s.created_at, s.updated_at
         FROM bank_statement_sources s
         JOIN companies c ON c.id = s.company_id
        WHERE s.deleted_at IS NULL
        ORDER BY s.created_at DESC`
    ).all();

    return ok(c, { sources: rows.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-statement-sources — create new source
// =============================================================================
bankStatementSources.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [
        { code: 'validation_error', message: 'Invalid input', details: parsed.error.flatten() },
      ]);
    }

    const { source_type, address, company_id, notes } = parsed.data;
    const id = `bss_${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);

    // Check duplicate within same type
    const existing = await c.env.DB.prepare(
      `SELECT id FROM bank_statement_sources
        WHERE source_type = ? AND address = ? AND deleted_at IS NULL`
    ).bind(source_type, address).first();

    if (existing) {
      return fail(c, 409, [
        { code: 'duplicate_source', message: `${address} is already registered as a ${source_type} source` },
      ]);
    }

    // email column is NOT NULL UNIQUE in legacy schema. For telegram rows we still
    // need to satisfy it — write a synthetic value tied to the address.
    const emailValue = source_type === 'email_inbox'
      ? address
      : `tg:${address}`;

    await c.env.DB.prepare(
      `INSERT INTO bank_statement_sources
         (id, source_type, address, email, company_id, is_active,
          created_at, updated_at, notes)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(id, source_type, address, emailValue, company_id, now, now, notes ?? null).run();

    const created = await c.env.DB.prepare(
      `SELECT s.id, s.source_type, s.address, s.email, s.company_id, c.abbreviation AS company_abbreviation,
              c.legal_name AS company_legal_name, s.is_active, s.notes,
              s.created_at, s.updated_at
         FROM bank_statement_sources s
         JOIN companies c ON c.id = s.company_id
        WHERE s.id = ?`
    ).bind(id).first();

    return ok(c, { source: created });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /api/bank-statement-sources/:id — update source
// =============================================================================
bankStatementSources.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, [
        { code: 'validation_error', message: 'Invalid input', details: parsed.error.flatten() },
      ]);
    }

    const existing = await c.env.DB.prepare(
      `SELECT id FROM bank_statement_sources WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first();
    if (!existing) {
      return fail(c, 404, [{ code: 'not_found', message: `Source ${id} not found` }]);
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (parsed.data.email !== undefined) { updates.push('email = ?'); params.push(parsed.data.email); }
    if (parsed.data.company_id !== undefined) { updates.push('company_id = ?'); params.push(parsed.data.company_id); }
    if (parsed.data.is_active !== undefined) { updates.push('is_active = ?'); params.push(parsed.data.is_active ? 1 : 0); }
    if (parsed.data.notes !== undefined) { updates.push('notes = ?'); params.push(parsed.data.notes); }

    if (updates.length === 0) {
      return fail(c, 422, [{ code: 'no_changes', message: 'No fields to update' }]);
    }

    updates.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(id);

    await c.env.DB.prepare(
      `UPDATE bank_statement_sources SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    return ok(c, { id });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// DELETE /api/bank-statement-sources/:id — soft delete
// =============================================================================
bankStatementSources.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE bank_statement_sources SET deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now, now, id).run();
    return ok(c, { id, deleted: true });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default bankStatementSources;
