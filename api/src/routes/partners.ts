import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const partners = new Hono<{ Bindings: Env }>();

// =============================================================================
// Slug generation — turn "Acme Trading LLC" into "acme-trading-llc".
// Cyrillic → Latin via simple map. Lowercase, dashes, ASCII-safe.
// =============================================================================
const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(input: string): string {
  const lower = input.toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (CYRILLIC_MAP[ch] !== undefined) {
      out += CYRILLIC_MAP[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else if (/\s|-|_/.test(ch)) {
      out += '-';
    }
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

async function resolveUniqueSlug(db: D1Database, base: string): Promise<string> {
  if (!base) base = 'partner';
  let candidate = base;
  let n = 1;
  while (true) {
    const existing = await db.prepare('SELECT id FROM partners WHERE id = ?').bind(candidate).first();
    if (!existing) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
    if (n > 100) throw new Error('slug_collision_overflow');
  }
}

// =============================================================================
// GET /api/partners — list all
// =============================================================================
partners.get('/', async (c) => {
  const sql = `
    SELECT
      p.id, p.trade_name, p.legal_name, p.country,
      p.tax_id, p.iban, p.swift_bic, p.bank_name,
      p.linked_entity_id, c.abbreviation as entity_abbreviation,
      p.price_type_id, pt.code as price_type_code,
      p.currency, p.contract_no, p.contract_date,
      p.email, p.status, p.crm_status, p.partner_type, p.notes,
      p.created_at, p.updated_at
    FROM partners p
    LEFT JOIN companies c ON p.linked_entity_id = c.id
    LEFT JOIN price_types pt ON p.price_type_id = pt.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.trade_name
  `;
  const results = await c.env.DB.prepare(sql).all();
  return ok(c, {
    count: results.results.length,
    partners: results.results,
  });
});

// =============================================================================
// GET /api/partners/:slug — single partner detail
// =============================================================================
partners.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const sql = `
    SELECT
      p.id, p.trade_name, p.legal_name, p.country,
      p.tax_id, p.iban, p.swift_bic, p.bank_name,
      p.linked_entity_id, c.abbreviation as entity_abbreviation,
      p.price_type_id, pt.code as price_type_code,
      p.currency, p.contract_no, p.contract_date,
      p.email, p.status, p.crm_status, p.partner_type, p.notes,
      p.legal_name_local, p.registered_address_local,
      p.kpp, p.inn, p.ogrn,
      p.payment_terms, p.preferred_incoterms, p.preferred_invoice_language,
      p.last_verified,
      p.created_at, p.updated_at
    FROM partners p
    LEFT JOIN companies c ON p.linked_entity_id = c.id
    LEFT JOIN price_types pt ON p.price_type_id = pt.id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `;

  const row = await c.env.DB.prepare(sql).bind(slug).first();

  if (!row) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${slug} not found` }]);
  }

  return ok(c, row);
});

// =============================================================================
// POST /api/partners — create new partner (Step 1: minimal)
// New partners always start as 'lead' (CRM-wise). They can't see prices
// until at least one signed agreement exists in partner_agreements.
// =============================================================================
const createPartnerSchema = z.object({
  trade_name: z.string().min(1).max(200),
  partner_type: z.enum(['buyer', 'supplier', 'shipper', 'other']),
  country: z.string().max(60).nullable().optional(),
  legal_name: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

partners.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = createPartnerSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  const baseSlug = slugify(data.trade_name);
  const slug = await resolveUniqueSlug(c.env.DB, baseSlug);
  const now = Math.floor(Date.now() / 1000);

  // Legacy 'status' column still has CHECK ('active'/'inactive'/'blocked'/'pending').
  // We seed it to 'pending' for new leads (closest legacy meaning) but the
  // semantic source of truth is 'crm_status' = 'lead'.
  try {
    await c.env.DB.prepare(`
      INSERT INTO partners (
        id, trade_name, legal_name, country, email,
        status, crm_status, partner_type, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 'lead', ?, ?, ?, ?)
    `).bind(
      slug,
      data.trade_name,
      data.legal_name ?? null,
      data.country ?? null,
      data.email ?? null,
      data.partner_type,
      data.notes ?? null,
      now,
      now
    ).run();
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to create partner',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    id: slug,
    trade_name: data.trade_name,
    crm_status: 'lead',
    partner_type: data.partner_type,
    country: data.country ?? null,
    legal_name: data.legal_name ?? null,
    email: data.email ?? null,
    notes: data.notes ?? null,
    created_at: now,
    updated_at: now,
  }, ['Partner created as Lead. Sign an NDA to promote to Potential.']);
});

// =============================================================================
// PATCH /api/partners/:slug — update partner (Step 2: banking, tax, prefs)
// =============================================================================
const updatePartnerSchema = z.object({
  trade_name: z.string().min(1).max(200).optional(),
  legal_name: z.string().max(200).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  email: z.string().email().nullable().optional(),
  partner_type: z.enum(['buyer', 'supplier', 'shipper', 'other']).optional(),
  iban: z.string().max(60).nullable().optional(),
  swift_bic: z.string().max(20).nullable().optional(),
  bank_name: z.string().max(200).nullable().optional(),
  tax_id: z.string().max(60).nullable().optional(),
  inn: z.string().max(20).nullable().optional(),
  kpp: z.string().max(20).nullable().optional(),
  ogrn: z.string().max(20).nullable().optional(),
  legal_name_local: z.string().max(200).nullable().optional(),
  registered_address_local: z.string().max(500).nullable().optional(),
  preferred_incoterms: z.string().max(20).nullable().optional(),
  preferred_invoice_language: z.enum(['EN', 'RU', 'BILINGUAL']).nullable().optional(),
  payment_terms: z.string().max(200).nullable().optional(),
  linked_entity_id: z.string().nullable().optional(),
  price_type_id: z.string().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

partners.patch('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first();

  if (!partner) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${slug} not found` }]);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = updatePartnerSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const fields: string[] = [];
  const binds: unknown[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      binds.push(value);
    }
  }

  if (fields.length === 0) {
    return fail(c, 400, [{ code: 'no_changes', message: 'No fields to update' }]);
  }

  fields.push('updated_at = ?');
  binds.push(now);
  binds.push(slug);

  try {
    await c.env.DB.prepare(
      `UPDATE partners SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...binds).run();
  } catch (err) {
    return fail(c, 500, [{
      code: 'update_failed',
      message: 'Failed to update partner',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, { id: slug, updated_at: now, fields_updated: fields.length - 1 });
});

// =============================================================================
// GET /api/partners/:slug/contracts — all contracts for a partner
// =============================================================================
partners.get('/:slug/contracts', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first();

  if (!partner) {
    return fail(c, 404, [{
      code: 'partner_not_found',
      message: `Partner ${slug} not found`,
    }]);
  }

  const result = await c.env.DB.prepare(`
    SELECT
      c.id, c.contract_no, c.our_company_id,
      co.abbreviation as entity_abbreviation,
      c.currency, c.signed_date, c.expiry_date, c.status
    FROM contracts c
    LEFT JOIN companies co ON c.our_company_id = co.id
    WHERE c.partner_id = ? AND c.deleted_at IS NULL
    ORDER BY c.contract_no
  `).bind(slug).all();

  return ok(c, {
    partner_id: slug,
    count: result.results.length,
    contracts: result.results,
  });
});

// =============================================================================
// GET /api/partners/:slug/agreements — list NDA/MOU/LOI/Contract docs
// =============================================================================
partners.get('/:slug/agreements', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first();

  if (!partner) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${slug} not found` }]);
  }

  const result = await c.env.DB.prepare(`
    SELECT id, agreement_type, title, signed_date, expiry_date,
           file_r2_key, status, notes, created_at, updated_at
    FROM partner_agreements
    WHERE partner_id = ? AND deleted_at IS NULL
    ORDER BY signed_date DESC, created_at DESC
  `).bind(slug).all();

  return ok(c, {
    partner_id: slug,
    count: result.results.length,
    agreements: result.results,
  });
});

// =============================================================================
// POST /api/partners/:slug/agreements — record signed agreement
// On success, if this is a 'signed' agreement and partner is 'lead',
// auto-promote crm_status: lead → potential.
// =============================================================================
const createAgreementSchema = z.object({
  agreement_type: z.enum(['nda', 'mou', 'loi', 'contract', 'amendment', 'other']),
  title: z.string().max(200).nullable().optional(),
  signed_date: z.number().int().positive().nullable().optional(),
  expiry_date: z.number().int().positive().nullable().optional(),
  file_r2_key: z.string().max(500).nullable().optional(),
  status: z.enum(['draft', 'signed', 'expired', 'cancelled']).default('signed'),
  notes: z.string().max(2000).nullable().optional(),
});

partners.post('/:slug/agreements', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id, crm_status FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first<{ id: string; crm_status: string }>();

  if (!partner) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${slug} not found` }]);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = createAgreementSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  const id = `agr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  let promoted = false;
  const stmts = [
    c.env.DB.prepare(`
      INSERT INTO partner_agreements (
        id, partner_id, agreement_type, title,
        signed_date, expiry_date, file_r2_key, status, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, slug, data.agreement_type, data.title ?? null,
      data.signed_date ?? null, data.expiry_date ?? null, data.file_r2_key ?? null,
      data.status, data.notes ?? null, now, now
    )
  ];

  if (data.status === 'signed' && partner.crm_status === 'lead') {
    promoted = true;
    stmts.push(
      c.env.DB.prepare('UPDATE partners SET crm_status = ?, updated_at = ? WHERE id = ?')
        .bind('potential', now, slug)
    );
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to record agreement',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    id,
    partner_id: slug,
    agreement_type: data.agreement_type,
    status: data.status,
    crm_promoted: promoted,
    new_crm_status: promoted ? 'potential' : partner.crm_status,
  }, promoted
    ? [`Partner promoted: lead → potential (first signed ${data.agreement_type.toUpperCase()})`]
    : ['Agreement recorded']);
});

export default partners;
