import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  generateNda, ndaTemplateKey, isPartnerLanguageSupported, requiresLocalLegalReview,
  type DeiCompanyForNda,
} from '../lib/llm-tasks/generate-nda';
import { markdownToDocxBuffer } from '../lib/md-to-docx';
import { loadBulkBalances } from './net-balance';

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
// contract_no / contract_date now derived from contracts table (earliest
// active main contract per partner). Falls back to legacy columns
// p.contract_no / p.contract_date when no real contract exists.
partners.get('/', async (c) => {
  // Query params:
  //   ?compact=1         → return only fields the partners table actually uses
  //                        (cuts payload ~85%: from 42KB → 6KB on 73 partners)
  //   ?include=balance   → bundle bulk net-balance into the same response,
  //                        eliminating the second round-trip + its CORS preflight
  const compact = c.req.query('compact') === '1';
  const includeBalance = c.req.query('include') === 'balance';

  const columns = compact
    ? `p.id, p.trade_name, p.legal_name, p.country,
       p.linked_entity_id, comp.abbreviation as entity_abbreviation,
       p.currency,
       COALESCE(ct.contract_no, p.contract_no) as contract_no,
       COALESCE(ct.signed_date, p.contract_date) as contract_date,
       p.status, p.crm_status, p.partner_type, p.kind,
       p.partner_language`
    : `p.id, p.trade_name, p.legal_name, p.country,
       p.tax_id, p.iban, p.swift_bic, p.bank_name,
       p.linked_entity_id, comp.abbreviation as entity_abbreviation,
       p.price_type_id, pt.code as price_type_code,
       p.currency,
       COALESCE(ct.contract_no, p.contract_no) as contract_no,
       COALESCE(ct.signed_date, p.contract_date) as contract_date,
       p.email, p.status, p.crm_status, p.partner_type, p.kind, p.notes,
       p.partner_language,
       p.created_at, p.updated_at`;

  const sql = `
    SELECT
      ${columns}
    FROM partners p
    LEFT JOIN companies comp ON p.linked_entity_id = comp.id
    LEFT JOIN price_types pt ON p.price_type_id = pt.id
    LEFT JOIN (
      SELECT partner_id, contract_no, signed_date,
             ROW_NUMBER() OVER (
               PARTITION BY partner_id
               ORDER BY signed_date ASC, created_at ASC
             ) as rn
      FROM contracts
      WHERE deleted_at IS NULL
        AND agreement_type = 'main'
        AND status = 'active'
        AND contract_no NOT LIKE 'NO-CONTRACT-%'
    ) ct ON ct.partner_id = p.id AND ct.rn = 1
    WHERE p.deleted_at IS NULL
    ORDER BY p.trade_name
  `;

  // Parallelize: partners SQL + bulk balances when requested.
  // Bulk balances internally fires its own queries; running in parallel saves
  // the longer of the two instead of summing them sequentially.
  const partnersPromise = c.env.DB.prepare(sql).all();
  const balancesPromise = includeBalance ? loadBulkBalances(c.env) : Promise.resolve(null);

  const [partnersResults, balancesResult] = await Promise.all([
    partnersPromise,
    balancesPromise,
  ]);

  const payload: Record<string, unknown> = {
    count: partnersResults.results.length,
    partners: partnersResults.results,
  };

  if (balancesResult) {
    payload.balances = balancesResult.balances;
    payload.fx_date = balancesResult.fx_date;
  }

  return ok(c, payload);
});

// =============================================================================
// GET /api/partners/:slug — single partner detail
// =============================================================================
// contract_no / contract_date derived from contracts table (same logic
// as the list endpoint above).
partners.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const sql = `
    SELECT
      p.id, p.trade_name, p.legal_name, p.country,
      p.tax_id, p.iban, p.swift_bic, p.bank_name,
      p.linked_entity_id, c.abbreviation as entity_abbreviation,
      p.price_type_id, pt.code as price_type_code,
      p.currency,
      COALESCE(ct.contract_no, p.contract_no) as contract_no,
      COALESCE(ct.signed_date, p.contract_date) as contract_date,
      p.email, p.status, p.crm_status, p.partner_type, p.notes,
      p.partner_language,
      p.legal_name_local, p.registered_address_local,
      p.kpp, p.inn, p.ogrn,
      p.payment_terms, p.preferred_incoterms, p.preferred_invoice_language,
      p.partner_local_language,
      p.last_verified,
      p.abbreviation,
      p.created_at, p.updated_at
    FROM partners p
    LEFT JOIN companies c ON p.linked_entity_id = c.id
    LEFT JOIN price_types pt ON p.price_type_id = pt.id
    LEFT JOIN (
      SELECT partner_id, contract_no, signed_date,
             ROW_NUMBER() OVER (
               PARTITION BY partner_id
               ORDER BY signed_date ASC, created_at ASC
             ) as rn
      FROM contracts
      WHERE deleted_at IS NULL
        AND agreement_type = 'main'
        AND status = 'active'
        AND contract_no NOT LIKE 'NO-CONTRACT-%'
    ) ct ON ct.partner_id = p.id AND ct.rn = 1
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
// until at least one signed agreement (any contract row, including NDA) exists.
// =============================================================================
const createPartnerSchema = z.object({
  trade_name: z.string().min(1).max(200),
  partner_type: z.enum(['buyer', 'supplier', 'shipper', 'other']),
  country: z.string().max(60).nullable().optional(),
  legal_name: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  partner_language: z.enum(['EN', 'RU', 'EN-RU', 'EN-AR', 'EN-VI', 'EN-ZH']).optional(),
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
        status, crm_status, partner_type, partner_language, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 'lead', ?, ?, ?, ?, ?)
    `).bind(
      slug,
      data.trade_name,
      data.legal_name ?? null,
      data.country ?? null,
      data.email ?? null,
      data.partner_type,
      data.partner_language ?? 'EN',
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
    partner_language: data.partner_language ?? 'EN',
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
  preferred_invoice_language: z.enum(['EN', 'RU', 'LOCAL', 'BILINGUAL']).nullable().optional(),
  partner_local_language: z.enum([
    'EN','RU','KA','ZH','VI','AM','UK','DE','TR','UZ','KK',
    'TH','ID','MS','HI','AR','FR','ES','PT'
  ]).nullable().optional(),
  partner_language: z.enum(['EN', 'RU', 'EN-RU', 'EN-AR', 'EN-VI', 'EN-ZH']).optional(),
  payment_terms: z.string().max(200).nullable().optional(),
  linked_entity_id: z.string().nullable().optional(),
  price_type_id: z.string().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // 2-6 letter uppercase code used in contract filenames:
  //   contracts/<entity>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf
  // Length 2-6 matches the seed in migration 0019.
  // Empty string allowed (clears the value); null also clears.
  abbreviation: z.string()
    .max(6)
    .regex(/^([A-Z]{2,6})?$/, 'Must be 2-6 uppercase letters A–Z, or empty')
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
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
      c.currency, c.signed_date, c.expiry_date, c.status,
      c.agreement_type, c.parent_contract_id, c.addendum_no, c.notes,
      c.contract_file_key
    FROM contracts c
    LEFT JOIN companies co ON c.our_company_id = co.id
    WHERE c.partner_id = ? AND c.deleted_at IS NULL
    ORDER BY
      COALESCE(c.parent_contract_id, c.id),
      CASE c.agreement_type WHEN 'main' THEN 0 ELSE 1 END,
      c.signed_date
  `).bind(slug).all();

  return ok(c, {
    partner_id: slug,
    count: result.results.length,
    contracts: result.results,
  });
});

// =============================================================================
// GET /api/partners/:slug/agreements — list legal docs (NDA / MOU / LOI / other)
// Now reads from `contracts` (single source of truth) where agreement_type
// is one of nda/mou/loi/other. Business contracts (main/addendum/annex/sla)
// continue to live in /api/partners/:slug/contracts.
//
// Returned shape preserves original PartnerAgreement contract for callers:
//   id, agreement_type, title (derived from contract_no), signed_date,
//   expiry_date, file_r2_key (=contract_file_key), status, notes,
//   created_at, updated_at.
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
    SELECT
      id,
      agreement_type,
      contract_no AS title,
      signed_date,
      expiry_date,
      contract_file_key AS file_r2_key,
      CASE WHEN status = 'active' THEN 'signed' ELSE status END AS status,
      notes,
      created_at,
      updated_at
    FROM contracts
    WHERE partner_id = ?
      AND deleted_at IS NULL
      AND agreement_type IN ('nda','mou','loi','other')
    ORDER BY signed_date DESC, created_at DESC
  `).bind(slug).all();

  return ok(c, {
    partner_id: slug,
    count: result.results.length,
    agreements: result.results,
  });
});

// =============================================================================
// POST /api/partners/:slug/agreements — record a legal doc (NDA/MOU/LOI/other)
// Now writes into `contracts` (single source of truth). The legacy
// 'contract' / 'amendment' values are mapped onto contracts.agreement_type:
//   contract  → 'main'
//   amendment → 'addendum'
// On success, if this is a 'signed' agreement (status='signed' → contract status='active')
// and partner is 'lead', auto-promote crm_status: lead → potential.
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

// Map legacy partner_agreements types onto canonical contracts.agreement_type.
function mapLegacyAgreementType(t: string): string {
  if (t === 'contract') return 'main';
  if (t === 'amendment') return 'addendum';
  return t;  // nda / mou / loi / other pass through
}

// Map legacy partner_agreements status onto contracts.status.
function mapLegacyAgreementStatus(s: string): string {
  if (s === 'signed') return 'active';
  return s;  // draft / expired / cancelled pass through
}

partners.post('/:slug/agreements', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id, abbreviation, crm_status FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first<{ id: string; abbreviation: string | null; crm_status: string }>();

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
  const canonicalType = mapLegacyAgreementType(data.agreement_type);
  const canonicalStatus = mapLegacyAgreementStatus(data.status);
  const now = Math.floor(Date.now() / 1000);

  // Default our_company_id and currency for legal docs (not financial)
  const ourCompanyId = 'dee';
  const currency = 'USD';

  // Need company.abbreviation to build a contract_no fallback
  const company = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM companies WHERE id = ?'
  ).bind(ourCompanyId).first<{ id: string; abbreviation: string | null }>();

  if (!company) {
    return fail(c, 500, [{
      code: 'default_company_missing',
      message: `Default company '${ourCompanyId}' not found in DB`,
    }]);
  }

  // Build contract_no: prefer the title if user provided one,
  // otherwise auto-generate <TYPE>-<ENTITY>-<PARTNER>-<DATE>.
  const dateForCode = new Date((data.signed_date ?? now) * 1000).toISOString().slice(0, 10);
  const partnerCode = (partner.abbreviation || slug).toUpperCase();
  const entityCode = (company.abbreviation || ourCompanyId).toUpperCase();
  const autoNo = `${canonicalType.toUpperCase()}-${entityCode}-${partnerCode}-${dateForCode}`;
  const contractNo = data.title?.trim() || autoNo;

  const id = `agr_${crypto.randomUUID()}`;

  let promoted = false;
  const stmts = [
    c.env.DB.prepare(`
      INSERT INTO contracts (
        id, contract_no, partner_id, our_company_id, currency,
        signed_date, expiry_date, contract_file_key, status, notes,
        agreement_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, contractNo, slug, ourCompanyId, currency,
      data.signed_date ?? null, data.expiry_date ?? null,
      data.file_r2_key ?? null, canonicalStatus, data.notes ?? null,
      canonicalType, now, now
    ),
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      return fail(c, 409, [{
        code: 'contract_no_exists',
        message: `Contract number ${contractNo} already exists`,
      }]);
    }
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to record agreement',
      details: { error: message },
    }]);
  }

  return ok(c, {
    id,
    partner_id: slug,
    agreement_type: data.agreement_type,
    status: data.status,
    contract_no: contractNo,
    crm_promoted: promoted,
    new_crm_status: promoted ? 'potential' : partner.crm_status,
  }, promoted
    ? [`Partner promoted: lead → potential (first signed ${data.agreement_type.toUpperCase()})`]
    : ['Agreement recorded']);
});

// =============================================================================
// POST /api/partners/:slug/agreements/generate-nda
// Workflow:
//   1. Read partner data from DB (must have crm_status='lead')
//   2. Read DEI company data from DB (cmp_dei) — currently DEI is the
//      only signing entity for NDAs; if other entities are needed later
//      we add ?signing_entity=cmp_dee param
//   3. Read NDA template + skill extract from R2 das-pricelists
//   4. Call DeepSeek PRO via legalizer-style prompt
//   5. Render markdown → DOCX
//   6. Upload to R2 das-erp-docs-dev under agreements/
//   7. Insert partner_agreements row (status='draft', agreement_type='nda')
//   8. Return agreement_id + download_url
// =============================================================================
partners.post('/:slug/agreements/generate-nda', async (c) => {
  const slug = c.req.param('slug');

  // Step 1 — partner (now includes partner_language for template selection)
  interface PartnerRow {
    id: string;
    trade_name: string;
    legal_name: string | null;
    country: string | null;
    registered_address_local: string | null;
    crm_status: string;
    email: string | null;
    partner_language: string | null;
  }
  const partner = await c.env.DB.prepare(
    `SELECT id, trade_name, legal_name, country, registered_address_local,
            crm_status, email, partner_language
     FROM partners WHERE id = ? AND deleted_at IS NULL`
  ).bind(slug).first<PartnerRow>();

  if (!partner) {
    return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${slug} not found` }]);
  }

  // Validate partner_language is supported
  if (!isPartnerLanguageSupported(partner.partner_language)) {
    return fail(c, 422, [{
      code: 'language_not_supported',
      message: `Partner language '${partner.partner_language}' has no NDA template yet. Supported: EN, RU, EN-RU, EN-AR, EN-VI, EN-ZH.`,
    }]);
  }

  // Step 2 — DEI
  interface DeiRow {
    legal_name: string;
    jurisdiction: string;
    registered_address: string;
    registration_no: string;
    signing_authority_name: string;
    signing_authority_title_en: string;
  }
  const dei = await c.env.DB.prepare(
    `SELECT legal_name, jurisdiction, registered_address, registration_no,
            signing_authority_name, signing_authority_title_en
     FROM companies WHERE id = 'dei'`
  ).first<DeiRow>();

  if (!dei || !dei.legal_name || !dei.signing_authority_name) {
    return fail(c, 500, [{
      code: 'dei_data_incomplete',
      message: 'DEI company record is missing required fields for NDA generation',
    }]);
  }

  // Step 3 — read templates + design canon from R2
  const templateR2Key = ndaTemplateKey(partner.partner_language);
  const [skillExtractObj, templateObj, canonObj] = await Promise.all([
    c.env.PRICELISTS.get('templates/nda-skill-extract.md'),
    c.env.PRICELISTS.get(templateR2Key),
    c.env.PRICELISTS.get('templates/das-design-canon.md'),
  ]);

  if (!skillExtractObj || !templateObj || !canonObj) {
    return fail(c, 500, [{
      code: 'template_missing',
      message: `Required template not found in R2 (key: ${templateR2Key})`,
    }]);
  }

  const skillExtract = await skillExtractObj.text();
  const template = await templateObj.text();
  const designCanon = await canonObj.text();

  // Step 4 — call DeepSeek
  const signingDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const deiForNda: DeiCompanyForNda = {
    legal_name: dei.legal_name,
    jurisdiction: dei.jurisdiction,
    registered_address: dei.registered_address,
    registration_no: dei.registration_no,
    signing_authority_name: dei.signing_authority_name,
    signing_authority_title: dei.signing_authority_title_en,
  };

  let ndaMarkdown: string;
  let tokensUsed: { in: number; out: number };
  try {
    const result = await generateNda({
      partner: {
        id: partner.id,
        trade_name: partner.trade_name,
        legal_name: partner.legal_name,
        country: partner.country,
        registered_address_local: partner.registered_address_local,
      },
      dei: deiForNda,
      signingDate,
      designCanon,
      skillExtract,
      template,
      apiKey: c.env.DEEPSEEK_API_KEY,
    });
    ndaMarkdown = result.markdown;
    tokensUsed = result.tokensUsed;
  } catch (err) {
    return fail(c, 500, [{
      code: 'llm_failed',
      message: 'DeepSeek call failed',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Step 5 — render DOCX
  let docxBuffer: Uint8Array;
  try {
    docxBuffer = await markdownToDocxBuffer(ndaMarkdown);
  } catch (err) {
    return fail(c, 500, [{
      code: 'render_failed',
      message: 'Markdown→DOCX rendering failed',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Step 6 — upload to R2
  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date(now * 1000).toISOString().slice(0, 10);
  const r2Key = `agreements/nda-${slug}-${dateStr}-${now}.docx`;

  try {
    await c.env.DOCS.put(r2Key, docxBuffer, {
      httpMetadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentDisposition: `attachment; filename="NDA-${partner.trade_name.replace(/[^a-z0-9]/gi, '_')}-${dateStr}.docx"`,
      },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_upload_failed',
      message: 'Failed to upload generated NDA to R2',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Step 7 — insert agreement record into `contracts` (draft, agreement_type='nda')
  const agreementId = `agr_${crypto.randomUUID()}`;
  const partnerLang = partner.partner_language ?? 'EN';
  const needsReview = requiresLocalLegalReview(partner.partner_language);
  const reviewNote = needsReview
    ? ' ⚠ Translation requires local legal review before signing.'
    : '';

  // Build a unique placeholder contract_no — DEI is the signing entity for NDAs.
  // Format: NDA-DEI-<PARTNER_ABBR_OR_SLUG>-<DATE>-<UNIX>
  // We append the unix timestamp so multiple drafts on the same day don't collide.
  const partnerAbbr = await c.env.DB.prepare(
    'SELECT abbreviation FROM partners WHERE id = ?'
  ).bind(slug).first<{ abbreviation: string | null }>();
  const partnerCode = (partnerAbbr?.abbreviation || slug).toUpperCase();
  const ndaContractNo = `NDA-DEI-${partnerCode}-${dateStr}-${now}`;

  try {
    await c.env.DB.prepare(`
      INSERT INTO contracts (
        id, contract_no, partner_id, our_company_id, currency,
        agreement_type, signed_date, expiry_date,
        contract_file_key, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'dei', 'USD', 'nda', NULL, NULL, ?, 'draft', ?, ?, ?)
    `).bind(
      agreementId,
      ndaContractNo,
      slug,
      r2Key,
      `Mutual NDA (${partnerLang}) — ${partner.trade_name} (${dateStr}). Generated by DeepSeek PRO. Tokens: ${tokensUsed.in} in, ${tokensUsed.out} out.${reviewNote}`,
      now, now
    ).run();
  } catch (err) {
    return fail(c, 500, [{
      code: 'db_insert_failed',
      message: 'NDA generated but failed to record in DB',
      details: { error: err instanceof Error ? err.message : String(err), r2_key: r2Key },
    }]);
  }

  const messages = [`NDA (${partnerLang}) generated. Status: draft.`];
  if (needsReview) {
    messages.push('⚠ Translation requires local legal review before sending.');
  }
  if (partner.email) {
    messages.push(`Send to ${partner.email} for signing.`);
  }

  return ok(c, {
    agreement_id: agreementId,
    partner_id: slug,
    partner_language: partnerLang,
    file_r2_key: r2Key,
    download_url: `/api/partners/${slug}/agreements/${agreementId}/download`,
    status: 'draft',
    requires_legal_review: needsReview,
    tokens_used: tokensUsed,
  }, messages);
});

// =============================================================================
// GET /api/partners/:slug/agreements/:id/download
// Streams the agreement file from R2 directly to the browser.
// =============================================================================
partners.get('/:slug/agreements/:id/download', async (c) => {
  const slug = c.req.param('slug');
  const id = c.req.param('id');

  const agreement = await c.env.DB.prepare(
    `SELECT contract_file_key AS file_r2_key, agreement_type, contract_no AS title
     FROM contracts
     WHERE id = ? AND partner_id = ? AND deleted_at IS NULL`
  ).bind(id, slug).first<{ file_r2_key: string | null; agreement_type: string; title: string | null }>();

  if (!agreement) {
    return fail(c, 404, [{ code: 'agreement_not_found', message: `Agreement ${id} not found` }]);
  }

  if (!agreement.file_r2_key) {
    return fail(c, 404, [{ code: 'no_file', message: 'Agreement has no attached file' }]);
  }

  const obj = await c.env.DOCS.get(agreement.file_r2_key);
  if (!obj) {
    return fail(c, 404, [{ code: 'r2_file_missing', message: `File ${agreement.file_r2_key} not in R2` }]);
  }

  const filename = agreement.title
    ? `${agreement.title.replace(/[^\w\s-]/g, '_')}.docx`
    : `${agreement.agreement_type}.docx`;

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

// =============================================================================
// POST /api/partners/recalc-status — recompute crm_status for all partners
// based on operations + contracts. Idempotent. Safe to call from cron or UI.
//
// Rules (Phase 8.1 lifecycle):
//   - operation in last 365 days  → active
//   - any operation (older)        → sleeping
//   - contract exists, no ops      → potential
//   - nothing (existing partner)   → sleeping
//
// `lead` is NEVER assigned by recalc — it is set ONLY when a brand-new
// partner is created via the UI form. As soon as recalc runs, a lead with
// no further activity transitions to sleeping.
// =============================================================================
partners.post('/recalc-status', async (c) => {
  const oneYearAgo = Math.floor(Date.now() / 1000) - 31_536_000;

  const result = await c.env.DB.prepare(`
    UPDATE partners
    SET crm_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM operations o
        WHERE o.partner_id = partners.id
          AND o.deleted_at IS NULL
          AND o.operation_date >= ?
      ) THEN 'active'
      WHEN EXISTS (
        SELECT 1 FROM operations o
        WHERE o.partner_id = partners.id
          AND o.deleted_at IS NULL
      ) THEN 'sleeping'
      WHEN EXISTS (
        SELECT 1 FROM contracts c
        WHERE c.partner_id = partners.id
          AND c.deleted_at IS NULL
      ) THEN 'potential'
      ELSE 'sleeping'
    END
    WHERE deleted_at IS NULL
      AND crm_status != 'lead'
  `).bind(oneYearAgo).run();

  // Pull a breakdown so the caller sees what happened
  const breakdown = await c.env.DB.prepare(`
    SELECT crm_status, COUNT(*) AS cnt
    FROM partners
    WHERE deleted_at IS NULL
    GROUP BY crm_status
  `).all<{ crm_status: string; cnt: number }>();

  return ok(c, {
    partners_updated: result.meta.changes ?? 0,
    breakdown: breakdown.results,
    threshold_unix: oneYearAgo,
    threshold_iso: new Date(oneYearAgo * 1000).toISOString(),
  });
});

export default partners;

