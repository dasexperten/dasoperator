import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const operationDocumentSources = new Hono<{ Bindings: Env }>();

// Mirror of bank-statement-sources normalizer.
function normalizeTelegramAddress(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const urlMatch = v.match(/^(?:https?:\/\/)?t\.me\/(.+)$/i);
  if (urlMatch) {
    const path = urlMatch[1].replace(/^\/+|\/+$/g, '');
    const privTopic = path.match(/^c\/(\d{5,})\/(\d+)\/\d+\/?$/);
    if (privTopic) return `-100${privTopic[1]}#${privTopic[2]}`;
    const privMsg = path.match(/^c\/(\d{5,})\/\d+\/?$/);
    if (privMsg) return `-100${privMsg[1]}`;
    const privOnly = path.match(/^c\/(\d{5,})\/?$/);
    if (privOnly) return `-100${privOnly[1]}`;
    const pub = path.match(/^([A-Za-z][A-Za-z0-9_]{3,31})(?:\/.*)?$/);
    if (pub) return `@${pub[1]}`;
    return null;
  }
  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v)) return v;
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(v)) return `@${v}`;
  if (/^\+\d{6,15}$/.test(v)) return v;
  if (/^-100\d{5,}#\d+$/.test(v)) return v;
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
  company_id: z.enum(['dee', 'dei', 'dasean', 'dec']).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().optional(),
});

// =============================================================================
// GET /api/operation-document-sources — list active sources
// =============================================================================
operationDocumentSources.get('/', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.source_type, s.address, s.company_id, s.is_active, s.notes,
              s.created_at, s.updated_at,
              c.id AS company_slug
         FROM operation_document_sources s
         LEFT JOIN companies c ON c.id = s.company_id
        WHERE s.deleted_at IS NULL
        ORDER BY s.created_at DESC`
    ).all();
    return ok(c, { sources: rows.results });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/operation-document-sources — create
// =============================================================================
operationDocumentSources.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, parsed.error.issues.map((i) => ({
        code: i.code, message: i.message, path: i.path,
      })));
    }
    const { source_type, address, company_id, notes } = parsed.data;

    // Reject duplicate (active or not, soft-deleted reactivates)
    const existing = await c.env.DB.prepare(
      `SELECT id, deleted_at FROM operation_document_sources
        WHERE source_type = ? AND address = ?`
    ).bind(source_type, address).first<{ id: string; deleted_at: number | null }>();

    const now = Math.floor(Date.now() / 1000);
    const id = existing?.id ?? `ods_${crypto.randomUUID()}`;

    if (existing) {
      await c.env.DB.prepare(
        `UPDATE operation_document_sources
            SET company_id = ?, is_active = 1, notes = ?,
                updated_at = ?, deleted_at = NULL
          WHERE id = ?`
      ).bind(company_id, notes ?? null, now, id).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO operation_document_sources
           (id, source_type, address, company_id, is_active, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(id, source_type, address, company_id, notes ?? null, now, now).run();
    }

    const row = await c.env.DB.prepare(
      `SELECT s.id, s.source_type, s.address, s.company_id, s.is_active, s.notes,
              s.created_at, s.updated_at
         FROM operation_document_sources s
        WHERE s.id = ?`
    ).bind(id).first();

    return ok(c, { source: row });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /api/operation-document-sources/:id — update
// =============================================================================
operationDocumentSources.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 422, parsed.error.issues.map((i) => ({
        code: i.code, message: i.message, path: i.path,
      })));
    }

    const existing = await c.env.DB.prepare(
      `SELECT id FROM operation_document_sources WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first();
    if (!existing) return fail(c, 404, [{ code: 'not_found', message: 'Source not found' }]);

    const fields: string[] = [];
    const values: any[] = [];
    if (parsed.data.company_id !== undefined) { fields.push('company_id = ?'); values.push(parsed.data.company_id); }
    if (parsed.data.is_active !== undefined) { fields.push('is_active = ?'); values.push(parsed.data.is_active ? 1 : 0); }
    if (parsed.data.notes !== undefined) { fields.push('notes = ?'); values.push(parsed.data.notes); }

    if (fields.length === 0) return ok(c, { id, updated: false });

    const now = Math.floor(Date.now() / 1000);
    fields.push('updated_at = ?'); values.push(now);
    values.push(id);

    await c.env.DB.prepare(
      `UPDATE operation_document_sources SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return ok(c, { id, updated: true });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// DELETE /api/operation-document-sources/:id — soft delete
// =============================================================================
operationDocumentSources.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const now = Math.floor(Date.now() / 1000);
    const r = await c.env.DB.prepare(
      `UPDATE operation_document_sources SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
    ).bind(now, now, id).run();
    return ok(c, { id, deleted: (r.meta?.changes ?? 0) > 0 });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default operationDocumentSources;
