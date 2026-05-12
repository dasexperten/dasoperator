import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const contracts = new Hono<{ Bindings: Env }>();

// =============================================================================
// Schemas
// =============================================================================

// agreement_type covers everything stored in `contracts`:
//   - business contracts: main, addendum, annex, sla
//   - legal docs:         nda, mou, loi, other
// For legal docs (nda/mou/loi/other), some business fields don't apply
// and are made optional below.
const AGREEMENT_TYPES = ['main', 'addendum', 'annex', 'sla', 'nda', 'mou', 'loi', 'other'] as const;
const LEGAL_DOC_TYPES = ['nda', 'mou', 'loi', 'other'] as const;
type AgreementType = typeof AGREEMENT_TYPES[number];

function isLegalDoc(t: AgreementType): boolean {
  return (LEGAL_DOC_TYPES as readonly string[]).includes(t);
}

const createSchema = z.object({
  contract_no: z.string().min(1).max(100).optional(),
  partner_id: z.string().min(1),
  our_company_id: z.string().min(1).optional(),
  currency: z.string().min(3).max(3).optional(),
  agreement_type: z.enum(AGREEMENT_TYPES).default('main'),
  signed_date: z.number().int().positive().optional(),
  expiry_date: z.number().int().positive().optional(),
  incoterms: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'expired', 'cancelled']).default('active'),
  notes: z.string().nullable().optional(),
  vat_rate: z.union([z.literal(0), z.literal(5), z.literal(20)]).default(0),
  // Russian currency-control fields (УНК / ВБК) — applicable to DEE foreign contracts
  unk_reference: z.string().nullable().optional(),
  unk_valid_until: z.number().int().positive().nullable().optional(),
});

const patchSchema = z.object({
  contract_no: z.string().min(1).max(100).optional(),
  agreement_type: z.enum(AGREEMENT_TYPES).optional(),
  signed_date: z.number().int().positive().nullable().optional(),
  expiry_date: z.number().int().positive().nullable().optional(),
  status: z.enum(['draft', 'active', 'expired', 'cancelled']).optional(),
  notes: z.string().nullable().optional(),
  currency: z.string().min(3).max(3).optional(),
  our_company_id: z.string().min(1).optional(),
  incoterms: z.string().nullable().optional(),
  vat_rate: z.union([z.literal(0), z.literal(5), z.literal(20)]).optional(),
  // Russian currency-control fields (УНК / ВБК)
  unk_reference: z.string().nullable().optional(),
  unk_valid_until: z.number().int().positive().nullable().optional(),
});

function genContractId(contractNo: string): string {
  const slug = contractNo.toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return slug;
}

// Build a deterministic placeholder contract_no for legal docs (NDA/MOU/LOI/other)
// when the caller didn't provide one. Format: <TYPE>-<ENTITY>-<PARTNER_ABBR>-<DATE>
// Example: NDA-DEE-LETU-2026-05-09
//
// If no abbreviation is set on the partner yet, falls back to the partner_id.
function buildLegalDocContractNo(opts: {
  type: AgreementType;
  entityAbbr: string;
  partnerAbbr: string | null;
  partnerId: string;
  signedAt: number;
}): string {
  const date = new Date(opts.signedAt * 1000).toISOString().slice(0, 10);
  const partnerCode = (opts.partnerAbbr || opts.partnerId).toUpperCase();
  return `${opts.type.toUpperCase()}-${opts.entityAbbr.toUpperCase()}-${partnerCode}-${date}`;
}

// =============================================================================
// GET /api/contracts — list all with JOINs
// =============================================================================
contracts.get('/', async (c) => {
  const sql = `
    SELECT
      c.id, c.contract_no, c.partner_id, p.trade_name as partner_trade_name,
      p.abbreviation as partner_abbreviation,
      c.our_company_id, co.abbreviation as entity_abbreviation,
      c.currency, c.signed_date, c.expiry_date, c.incoterms,
      c.status, c.notes, c.vat_rate, c.contract_file_key,
      c.agreement_type, c.addendum_no, c.parent_contract_id,
      c.unk_reference, c.unk_valid_until,
      c.created_at, c.updated_at
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
// Supports both:
//   - business contracts (main/addendum/annex/sla) — requires contract_no, our_company_id, currency
//   - legal docs (nda/mou/loi/other) — auto-fills missing fields with safe defaults
//     (our_company_id='dee', currency='USD', auto-generated contract_no based on type+entity+partner_abbr+date)
// On insert, if status='active' and partner.crm_status='lead', auto-promote to 'potential'.
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
  const isLegal = isLegalDoc(data.agreement_type);

  // Apply defaults for legal documents (NDA/MOU/LOI/other)
  const our_company_id = data.our_company_id ?? (isLegal ? 'dee' : null);
  const currency = data.currency ?? (isLegal ? 'USD' : null);

  // Business contracts require explicit our_company_id and currency
  if (!our_company_id) {
    return fail(c, 422, [{
      code: 'our_company_id_required',
      message: 'our_company_id is required for business contracts (main/addendum/annex/sla)',
    }]);
  }
  if (!currency) {
    return fail(c, 422, [{
      code: 'currency_required',
      message: 'currency is required for business contracts (main/addendum/annex/sla)',
    }]);
  }

  // Verify partner exists (and load abbreviation + crm_status)
  const partner = await c.env.DB.prepare(
    'SELECT id, abbreviation, crm_status FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(data.partner_id).first<{ id: string; abbreviation: string | null; crm_status: string }>();

  if (!partner) {
    return fail(c, 404, [{
      code: 'partner_not_found',
      message: `partner_id ${data.partner_id} does not exist`,
    }]);
  }

  // Verify company exists (and load abbreviation for fallback contract_no)
  const company = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM companies WHERE id = ?'
  ).bind(our_company_id).first<{ id: string; abbreviation: string | null }>();

  if (!company) {
    return fail(c, 404, [{
      code: 'company_not_found',
      message: `our_company_id ${our_company_id} does not exist`,
    }]);
  }

  const now = Math.floor(Date.now() / 1000);

  // Determine final contract_no:
  //   - business contracts MUST provide it
  //   - legal docs without contract_no get an auto-generated placeholder
  let contractNo = data.contract_no;
  if (!contractNo) {
    if (!isLegal) {
      return fail(c, 422, [{
        code: 'contract_no_required',
        message: 'contract_no is required for business contracts (main/addendum/annex/sla)',
      }]);
    }
    contractNo = buildLegalDocContractNo({
      type: data.agreement_type,
      entityAbbr: company.abbreviation || our_company_id,
      partnerAbbr: partner.abbreviation,
      partnerId: data.partner_id,
      signedAt: data.signed_date ?? now,
    });
  }

  const id = genContractId(contractNo);

  // Auto-promotion: if a NEW signed contract lands on a lead partner, promote to potential.
  // Trigger condition: status='active' (means signed and live).
  const willPromote = data.status === 'active' && partner.crm_status === 'lead';

  const stmts = [
    c.env.DB.prepare(`
      INSERT INTO contracts (
        id, contract_no, partner_id, our_company_id, currency,
        signed_date, expiry_date, incoterms, status, notes, vat_rate,
        agreement_type, unk_reference, unk_valid_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, contractNo, data.partner_id, our_company_id, currency,
      data.signed_date ?? null, data.expiry_date ?? null,
      data.incoterms ?? null, data.status, data.notes ?? null, data.vat_rate,
      data.agreement_type, data.unk_reference ?? null, data.unk_valid_until ?? null,
      now, now
    ),
  ];

  if (willPromote) {
    stmts.push(
      c.env.DB.prepare(
        'UPDATE partners SET crm_status = ?, updated_at = ? WHERE id = ?'
      ).bind('potential', now, data.partner_id)
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
      message: 'Failed to create contract',
      details: { error: message },
    }]);
  }

  const messages = ['Contract created'];
  if (willPromote) {
    messages.push(`Partner promoted: lead → potential (first signed ${data.agreement_type.toUpperCase()})`);
  }

  return ok(c, {
    id, contract_no: contractNo, partner_id: data.partner_id,
    our_company_id, currency,
    agreement_type: data.agreement_type,
    status: data.status, vat_rate: data.vat_rate,
    crm_promoted: willPromote,
    new_crm_status: willPromote ? 'potential' : partner.crm_status,
    created_at: now, updated_at: now,
  }, messages);
});

// =============================================================================
// PATCH /api/contracts/:id — update editable fields
// Allowed: contract_no, agreement_type, signed_date, expiry_date,
//          status, notes, currency, our_company_id, incoterms, vat_rate.
// NOT allowed via PATCH: partner_id (must delete and recreate to move).
// On status flip to 'active' on a partner with crm_status='lead', auto-promote.
// =============================================================================
contracts.patch('/:id', async (c) => {
  const id = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return fail(c, 400, [{ code: 'empty_patch', message: 'PATCH body has no fields to update' }]);
  }

  // Load existing contract + partner crm_status
  const existing = await c.env.DB.prepare(`
    SELECT c.id, c.partner_id, c.status as old_status,
           p.crm_status as partner_crm_status
    FROM contracts c
    LEFT JOIN partners p ON c.partner_id = p.id
    WHERE c.id = ? AND c.deleted_at IS NULL
  `).bind(id).first<{
    id: string;
    partner_id: string;
    old_status: string;
    partner_crm_status: string;
  }>();

  if (!existing) {
    return fail(c, 404, [{
      code: 'contract_not_found',
      message: `Contract ${id} not found`,
    }]);
  }

  // Validate company if changing
  if (data.our_company_id) {
    const company = await c.env.DB.prepare(
      'SELECT id FROM companies WHERE id = ?'
    ).bind(data.our_company_id).first();
    if (!company) {
      return fail(c, 404, [{
        code: 'company_not_found',
        message: `our_company_id ${data.our_company_id} does not exist`,
      }]);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  for (const [field, value] of Object.entries(data)) {
    sets.push(`${field} = ?`);
    binds.push(value === undefined ? null : (value as string | number | null));
  }
  sets.push('updated_at = ?');
  binds.push(now);
  binds.push(id); // WHERE

  // Auto-promotion: if status becomes 'active' and partner is 'lead' and the
  // contract WAS NOT already 'active', promote.
  const willPromote =
    data.status === 'active' &&
    existing.old_status !== 'active' &&
    existing.partner_crm_status === 'lead';

  const stmts = [
    c.env.DB.prepare(`UPDATE contracts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds),
  ];

  if (willPromote) {
    stmts.push(
      c.env.DB.prepare(
        'UPDATE partners SET crm_status = ?, updated_at = ? WHERE id = ?'
      ).bind('potential', now, existing.partner_id)
    );
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) {
      return fail(c, 409, [{
        code: 'contract_no_exists',
        message: `Contract number ${data.contract_no} already exists`,
      }]);
    }
    return fail(c, 500, [{
      code: 'patch_failed',
      message: 'Failed to update contract',
      details: { error: message },
    }]);
  }

  const messages = ['Contract updated'];
  if (willPromote) {
    messages.push('Partner promoted: lead → potential');
  }

  return ok(c, {
    id, fields_updated: Object.keys(data),
    crm_promoted: willPromote,
    updated_at: now,
  }, messages);
});

// =============================================================================
// POST /api/contracts/:id/file — upload contract PDF to R2
// Body: multipart/form-data with field "file" (PDF, max 20 MB)
// Effects:
//   - uploads to R2 bucket DOCS at key `contracts/<company>/<partner>_<date>.pdf`
//   - writes the key to contracts.contract_file_key
// =============================================================================
contracts.post('/:id/file', async (c) => {
  const id = c.req.param('id');

  // Load contract + partner abbreviation
  const row = await c.env.DB.prepare(`
    SELECT c.id, c.partner_id, c.our_company_id, c.signed_date, c.contract_file_key,
           p.abbreviation as partner_abbr, p.trade_name as partner_name
    FROM contracts c
    LEFT JOIN partners p ON p.id = c.partner_id
    WHERE c.id = ? AND c.deleted_at IS NULL
  `).bind(id).first<{
    id: string;
    partner_id: string;
    our_company_id: string;
    signed_date: number | null;
    contract_file_key: string | null;
    partner_abbr: string | null;
    partner_name: string | null;
  }>();

  if (!row) {
    return fail(c, 404, [{ code: 'contract_not_found', message: `Contract ${id} not found` }]);
  }

  // Partner must have a 4-letter abbreviation set before any contract file
  // can be uploaded. The abbreviation is part of the canonical filename
  // <ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf — without it the file would not be
  // identifiable.
  if (!row.partner_abbr || row.partner_abbr.length === 0) {
    return fail(c, 422, [{
      code: 'partner_abbreviation_missing',
      message: `Partner ${row.partner_id} has no abbreviation set. Set partners.abbreviation (4 letters uppercase) before uploading contract files.`,
    }]);
  }

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return fail(c, 400, [{
      code: 'invalid_multipart',
      message: 'Body must be multipart/form-data with a "file" field',
    }]);
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return fail(c, 400, [{
      code: 'no_file',
      message: 'Form field "file" missing or not a file',
    }]);
  }

  // Validate type and size
  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
  if (file.size > MAX_BYTES) {
    return fail(c, 413, [{
      code: 'file_too_large',
      message: `File size ${file.size} exceeds 20 MB limit`,
    }]);
  }

  if (file.type && file.type !== 'application/pdf') {
    return fail(c, 415, [{
      code: 'unsupported_media_type',
      message: `Content-Type ${file.type} not allowed; only application/pdf`,
    }]);
  }

  // Build R2 key: contracts/<company>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf
  // Entity comes from our_company_id uppercased; abbreviation is partner code.
  const entity = row.our_company_id.toUpperCase();
  const abbr = row.partner_abbr.toUpperCase();
  const dateStr = row.signed_date
    ? new Date(row.signed_date * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const r2Key = `contracts/${row.our_company_id}/${entity}-${abbr}-${dateStr}.pdf`;

  // Upload to R2
  const buffer = await file.arrayBuffer();
  try {
    await c.env.DOCS.put(r2Key, buffer, {
      httpMetadata: { contentType: 'application/pdf' },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_put_failed',
      message: 'Failed to upload file to R2',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Update contract row
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    UPDATE contracts
    SET contract_file_key = ?, updated_at = ?
    WHERE id = ?
  `).bind(r2Key, now, id).run();

  return ok(c, {
    contract_id: id,
    contract_file_key: r2Key,
    size_bytes: file.size,
    uploaded_at: now,
  }, ['Contract file uploaded']);
});

// =============================================================================
// GET /api/contracts/:id/file — stream contract PDF from R2
// =============================================================================
contracts.get('/:id/file', async (c) => {
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(`
    SELECT contract_file_key FROM contracts WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first<{ contract_file_key: string | null }>();

  if (!row) {
    return fail(c, 404, [{ code: 'contract_not_found', message: `Contract ${id} not found` }]);
  }

  if (!row.contract_file_key) {
    return fail(c, 404, [{
      code: 'no_file_uploaded',
      message: `Contract ${id} has no file attached`,
    }]);
  }

  const obj = await c.env.DOCS.get(row.contract_file_key);
  if (!obj) {
    return c.text('R2 object missing', 404);
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/pdf',
      'Content-Disposition': `inline; filename="${row.contract_file_key.split('/').pop()}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

// =============================================================================
// DELETE /api/contracts/:id/file — remove file from R2 and clear key
// =============================================================================
contracts.delete('/:id/file', async (c) => {
  const id = c.req.param('id');

  const row = await c.env.DB.prepare(`
    SELECT contract_file_key FROM contracts WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first<{ contract_file_key: string | null }>();

  if (!row) {
    return fail(c, 404, [{ code: 'contract_not_found', message: `Contract ${id} not found` }]);
  }

  if (row.contract_file_key) {
    try {
      await c.env.DOCS.delete(row.contract_file_key);
    } catch {
      // R2 delete failures are non-fatal — still clear the DB pointer
    }
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(`
    UPDATE contracts SET contract_file_key = NULL, updated_at = ? WHERE id = ?
  `).bind(now, id).run();

  return ok(c, { contract_id: id }, ['Contract file removed']);
});

export default contracts;
