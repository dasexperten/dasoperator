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
  return slug;
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
