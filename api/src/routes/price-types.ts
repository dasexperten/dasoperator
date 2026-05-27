// =============================================================================
// Price Types — CRUD for the global price-type catalog.
//
// Each price type is a (code, description, currency, used_by_entity) tuple
// that any product can opt into via product_prices. The list lives in D1 and
// is editable from the UI (Settings → Price Types, and the "+ Create new"
// modal on the product page).
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const priceTypes = new Hono<{ Bindings: Env }>();

interface PriceTypeRow {
  id: string;
  code: string;
  description: string | null;
  currency: string;
  used_by_entity: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

// =============================================================================
// GET /api/price-types — list price types
// Query: ?include_inactive=1 to include deactivated ones (default: active only)
// =============================================================================
priceTypes.get('/', async (c) => {
  const includeInactive = c.req.query('include_inactive') === '1';
  const sql = includeInactive
    ? `SELECT id, code, description, currency, used_by_entity, active, created_at, updated_at
       FROM price_types
       ORDER BY active DESC, code ASC`
    : `SELECT id, code, description, currency, used_by_entity, active, created_at, updated_at
       FROM price_types
       WHERE active = 1
       ORDER BY code ASC`;

  const result = await c.env.DB.prepare(sql).all<PriceTypeRow>();
  return ok(c, { count: result.results.length, price_types: result.results });
});

// =============================================================================
// POST /api/price-types — create a new price type
// Body: { code, currency, description?, used_by_entity?, id? }
//   id  — optional slug; auto-derived from code (lowercased, _) if omitted
//   currency — 3-letter ISO code (RUB, USD, CNY, VND, AMD, AED, EUR, KZT, etc.)
//   used_by_entity — free text, e.g. "DEE" or "DEI / DEASEAN / DEC"
// =============================================================================
const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, 'id must be lowercase letters, digits, underscores').optional(),
  code: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be 3 uppercase letters (ISO 4217)'),
  used_by_entity: z.string().max(200).nullable().optional(),
});

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

priceTypes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{
      code: 'invalid_body',
      message: 'Validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }
  const data = parsed.data;

  const id = data.id ?? slugify(data.code);
  if (!id) {
    return fail(c, 400, [{ code: 'invalid_id', message: 'Could not derive id from code' }]);
  }

  // Uniqueness check on both id and code (code is UNIQUE in schema; id is PK)
  const dup = await c.env.DB.prepare(
    'SELECT id, code FROM price_types WHERE id = ? OR code = ?'
  ).bind(id, data.code).first<{ id: string; code: string }>();

  if (dup) {
    const collision = dup.id === id ? `id "${id}"` : `code "${data.code}"`;
    return fail(c, 409, [{
      code: 'duplicate',
      message: `A price type with ${collision} already exists`,
    }]);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    INSERT INTO price_types (id, code, description, currency, used_by_entity, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    id,
    data.code,
    data.description ?? null,
    data.currency,
    data.used_by_entity ?? null,
    now,
    now,
  ).run();

  const created = await c.env.DB.prepare(
    'SELECT id, code, description, currency, used_by_entity, active, created_at, updated_at FROM price_types WHERE id = ?'
  ).bind(id).first<PriceTypeRow>();

  return ok(c, created);
});

// =============================================================================
// PATCH /api/price-types/:id — update a price type
// Body: any subset of { code, description, currency, used_by_entity, active }
// =============================================================================
const patchSchema = z.object({
  code: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  used_by_entity: z.string().max(200).nullable().optional(),
  active: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
});

priceTypes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{
      code: 'invalid_body',
      message: 'Validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }
  const data = parsed.data;

  const existing = await c.env.DB.prepare('SELECT id FROM price_types WHERE id = ?').bind(id).first();
  if (!existing) {
    return fail(c, 404, [{ code: 'not_found', message: `Price type "${id}" not found` }]);
  }

  // If code is being changed, check uniqueness
  if (data.code !== undefined) {
    const dup = await c.env.DB.prepare(
      'SELECT id FROM price_types WHERE code = ? AND id != ?'
    ).bind(data.code, id).first();
    if (dup) {
      return fail(c, 409, [{
        code: 'duplicate_code',
        message: `Another price type already uses code "${data.code}"`,
      }]);
    }
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.code !== undefined) { sets.push('code = ?'); values.push(data.code); }
  if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description); }
  if (data.currency !== undefined) { sets.push('currency = ?'); values.push(data.currency); }
  if (data.used_by_entity !== undefined) { sets.push('used_by_entity = ?'); values.push(data.used_by_entity); }
  if (data.active !== undefined) {
    const activeInt = typeof data.active === 'boolean' ? (data.active ? 1 : 0) : data.active;
    sets.push('active = ?');
    values.push(activeInt);
  }

  if (sets.length === 0) {
    return fail(c, 400, [{ code: 'no_changes', message: 'No fields provided to update' }]);
  }

  const now = Math.floor(Date.now() / 1000);
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await c.env.DB.prepare(`UPDATE price_types SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();

  const updated = await c.env.DB.prepare(
    'SELECT id, code, description, currency, used_by_entity, active, created_at, updated_at FROM price_types WHERE id = ?'
  ).bind(id).first<PriceTypeRow>();

  return ok(c, updated);
});

export default priceTypes;
