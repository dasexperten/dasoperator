// =============================================================================
// /api/operations/upload-document — drop a document, auto-link to operation
// =============================================================================
//
// Flow:
//   1. Save file to R2 (operation-docs/YYYY-MM-DD/{uuid}__{filename})
//   2. Extract text from file
//   3. Send to DeepSeek with extraction prompt
//   4. Match reference (DEE-007 / DEI-012 / DEASEAN-003 / DEC-001) to operations
//   5. Auto-link via operation_attachments OR return suggestion list +
//      pre-filled fields for creating a new operation
//
// Phase 5.2 — Create-from-document support:
//   When the LLM returns counterparty/issuer/amount but no match in DB,
//   the response now includes `prefill` block — partner_id/manufacturer_id/
//   our_company_id/currency/amount/date — so the UI can show a one-click
//   "Create stub & attach" form.
//
//   The /create-from-document endpoint creates a draft operation without
//   line_items (operations table allows this — line_items is a separate
//   table) and immediately attaches the already-uploaded file from R2.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import { extractTextFromFile } from '../lib/bank-statement-parser';
import { issueOperationReference } from '../lib/operation-reference';

const operationDocs = new Hono<{ Bindings: Env }>();

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

const DOC_EXTRACTION_PROMPT = `You are a document classifier for Das Experten ERP.
Documents reference operations by ID: DEE-N / DEI-N / DEASEAN-N / DEC-N (e.g. DEE-007, DEI-012).

Read the document and output ONLY valid JSON:
{
  "operation_reference": string | null,    // e.g. "DEE-007", null if not found
  "doc_type": "invoice" | "packing_list" | "upd" | "contract" | "annex" | "specification" | "transport_note" | "act" | "other",
  "doc_number": string | null,
  "doc_date": "YYYY-MM-DD" | null,
  "currency": "RUB" | "USD" | "EUR" | "CNY" | "VND" | "AED" | "AMD" | null,
  "amount": number | null,
  "issuer": string | null,                 // name of the company that issued the document
  "counterparty": string | null,           // the other side
  "direction": "outgoing" | "incoming",    // outgoing = Das Experten issued it, incoming = we received it
  "confidence": 0.0-1.0,                   // how sure about the operation_reference
  "notes": string                          // any other detail worth keeping
}

operation_reference must match exactly DEE-\\d+ / DEI-\\d+ / DEASEAN-\\d+ / DEC-\\d+. If multiple candidates appear, pick the one most central to the document (in header or main reference field, not random mention).
Set operation_reference to null if you don't see a clear match.`;

interface ExtractedDoc {
  operation_reference: string | null;
  doc_type: string;
  doc_number: string | null;
  doc_date: string | null;
  currency: string | null;
  amount: number | null;
  issuer: string | null;
  counterparty: string | null;
  direction: 'outgoing' | 'incoming';
  confidence: number;
  notes: string;
}

interface PrefillData {
  // Pre-resolved IDs (best fuzzy match against DB) — may be null if no good match
  partner_id: string | null;
  partner_name: string | null;
  partner_subtype: 'service_provider' | 'logistics' | 'agency' | null;
  manufacturer_id: string | null;
  manufacturer_name: string | null;
  our_company_id: string | null;
  our_company_abbr: string | null;
  // Suggested operation type based on direction + matches
  operation_type: 'sale' | 'purchase' | 'transfer' | null;
  // Raw extracted values for editing
  currency: string | null;
  amount: number | null;
  doc_date: string | null;
  // File reference for later attach
  r2_key: string;
  filename: string;
  file_mime: string;
  file_size: number;
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  return base.normalize('NFKD').replace(/[^\w\d.\-]/g, '_').replace(/_+/g, '_').slice(0, 120);
}

function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\sа-яёa-z0-9]/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-overlap fuzzy match: return best DB candidate above similarity threshold
function pickBestMatch<T extends { id: string; name: string }>(
  candidates: T[],
  query: string,
  minOverlap = 0.5,
): T | null {
  if (!query || candidates.length === 0) return null;
  const qTokens = new Set(normalizeForMatch(query).split(' ').filter((t) => t.length >= 2));
  if (qTokens.size === 0) return null;

  let best: T | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const cTokens = new Set(normalizeForMatch(c.name).split(' ').filter((t) => t.length >= 2));
    if (cTokens.size === 0) continue;
    let overlap = 0;
    for (const t of qTokens) if (cTokens.has(t)) overlap += 1;
    const denom = Math.min(qTokens.size, cTokens.size);
    const score = denom > 0 ? overlap / denom : 0;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return bestScore >= minOverlap ? best : null;
}

// =============================================================================
// Build prefill from extracted doc + DB lookups for new-operation creation
// =============================================================================
async function buildPrefill(
  env: Env,
  extracted: ExtractedDoc,
  r2Key: string,
  filename: string,
  fileMime: string,
  fileSize: number,
): Promise<PrefillData> {
  // Load partner candidates (active only)
  const partnerRows = await env.DB.prepare(
    `SELECT id, trade_name as name, partner_subtype FROM partners WHERE deleted_at IS NULL`
  ).all<{ id: string; name: string; partner_subtype: string | null }>();
  // Load manufacturer candidates
  const mfgRows = await env.DB.prepare(
    `SELECT id, name FROM manufacturers`
  ).all<{ id: string; name: string }>();
  // Load company candidates (we issue → our_company_id; we receive → counterparty)
  const compRows = await env.DB.prepare(
    `SELECT id, abbreviation as name, legal_name, trade_name FROM companies WHERE deleted_at IS NULL`
  ).all<{ id: string; name: string; legal_name: string; trade_name: string }>();

  // Direction interpretation:
  //   outgoing = Das Experten issued document → our_company = issuer, counterparty = partner
  //   incoming = Das Experten received       → our_company = counterparty (we're recipient),
  //                                            partner/manufacturer = issuer (the one who sent it)
  const ourSideRaw = extracted.direction === 'outgoing' ? extracted.issuer : extracted.counterparty;
  const otherSideRaw = extracted.direction === 'outgoing' ? extracted.counterparty : extracted.issuer;

  // Match our company across all its name variants
  let bestCompany: { id: string; name: string } | null = null;
  if (ourSideRaw) {
    const companyCandidates = (compRows.results ?? []).flatMap((c) => [
      { id: c.id, name: c.name },
      { id: c.id, name: c.legal_name },
      { id: c.id, name: c.trade_name },
    ].filter((x) => x.name));
    bestCompany = pickBestMatch(companyCandidates, ourSideRaw, 0.4);
  }

  // Match counterparty against partners AND manufacturers
  let bestPartner: { id: string; name: string } | null = null;
  let bestManufacturer: { id: string; name: string } | null = null;
  if (otherSideRaw) {
    bestPartner = pickBestMatch(partnerRows.results ?? [], otherSideRaw, 0.45);
    bestManufacturer = pickBestMatch(mfgRows.results ?? [], otherSideRaw, 0.45);
  }

  // Decide operation_type:
  //   - If we matched a manufacturer (Chinese factory etc.) AND direction=incoming → purchase
  //   - If we matched a partner AND direction=outgoing → sale (we billed them)
  //   - If we matched a partner AND direction=incoming → purchase from non-factory supplier
  //   - Default to null (let user pick)
  let operationType: 'sale' | 'purchase' | 'transfer' | null = null;
  if (bestManufacturer && extracted.direction === 'incoming') {
    operationType = 'purchase';
  } else if (bestPartner && extracted.direction === 'outgoing') {
    operationType = 'sale';
  } else if (bestPartner && extracted.direction === 'incoming') {
    operationType = 'purchase';
  }

  // Look up the matched partner's subtype to surface in UI and downstream
  // create-from-document call. Drives operation_track=service when set.
  const partnerSubtype = bestPartner
    ? ((partnerRows.results ?? []).find((p) => p.id === bestPartner!.id)?.partner_subtype ?? null)
    : null;

  return {
    partner_id: bestPartner?.id ?? null,
    partner_name: bestPartner?.name ?? otherSideRaw ?? null,
    partner_subtype: partnerSubtype,
    manufacturer_id: bestManufacturer?.id ?? null,
    manufacturer_name: bestManufacturer?.name ?? null,
    our_company_id: bestCompany?.id ?? null,
    our_company_abbr: bestCompany?.name ?? null,
    operation_type: operationType,
    currency: extracted.currency,
    amount: extracted.amount,
    doc_date: extracted.doc_date,
    r2_key: r2Key,
    filename,
    file_mime: fileMime,
    file_size: fileSize,
  };
}

// =============================================================================
// POST /api/operations/upload-document
//   multipart/form-data: file=<binary>, operation_id?=<existing op>
//
//   If operation_id is provided, skip parsing and just attach.
//   If not, parse → match → either auto-attach (high conf) or return candidates.
// =============================================================================
operationDocs.post('/upload-document', async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file') as File | null;
    const forcedOpId = form.get('operation_id') as string | null;

    if (!file) {
      return fail(c, 422, [{ code: 'no_file', message: 'No file uploaded' }]);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = file.name;
    const mimeType = file.type;
    const safeName = sanitizeFilename(filename);
    const fileId = crypto.randomUUID();

    // 1. Save to R2
    const r2Key = `operation-docs/${new Date().toISOString().slice(0, 10)}/${fileId}__${safeName}`;
    try {
      await c.env.DOCS.put(r2Key, bytes, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' },
      });
    } catch (e) {
      console.error('[op-docs] R2 upload failed:', e);
    }

    // 2. If user already picked the operation, just attach
    if (forcedOpId) {
      const exists = await c.env.DB.prepare(
        'SELECT id, reference FROM operations WHERE id = ? AND deleted_at IS NULL'
      ).bind(forcedOpId).first<{ id: string; reference: string }>();
      if (!exists) {
        return fail(c, 404, [{ code: 'operation_not_found', message: 'Operation does not exist' }]);
      }

      const attachId = `att_${crypto.randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      const attachR2Key = `attachments/${forcedOpId}/${fileId}-${safeName}`;
      await c.env.DOCS.put(attachR2Key, bytes, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' },
      });
      const attachUrl = `/api/attachment-files/${fileId}-${safeName}?op=${forcedOpId}`;

      await c.env.DB.prepare(
        `INSERT INTO operation_attachments
           (id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
            issuer, file_url, parsed_from, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        attachId, forcedOpId, 'incoming', 'other',
        null, null, null, null,
        null, attachUrl, 'manual', `Uploaded: ${filename}`, now, now
      ).run();

      return ok(c, {
        mode: 'manual_attached',
        operation_id: forcedOpId,
        operation_reference: exists.reference,
        attachment_id: attachId,
        file_url: attachUrl,
      });
    }

    // 3. Extract text
    const text = await extractTextFromFile(bytes, mimeType, filename);
    if (text.length < 30) {
      return ok(c, {
        mode: 'unreadable',
        suggestion: null,
        candidates: [],
        r2_key: r2Key,
        filename,
        file_mime: mimeType,
        file_size: bytes.length,
        message: 'Could not read text from file. Please pick an operation manually.',
      });
    }

    // 4. Classify with DeepSeek
    if (!c.env.DEEPSEEK_API_KEY) {
      return ok(c, {
        mode: 'no_llm',
        r2_key: r2Key,
        filename,
        file_mime: mimeType,
        file_size: bytes.length,
        message: 'LLM not configured. Please pick an operation manually.',
      });
    }

    const trimmed = text.length > 60_000 ? text.slice(0, 60_000) : text;

    const dsResp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: DOC_EXTRACTION_PROMPT },
          { role: 'user', content: `Filename: ${filename}\n\nContents:\n${trimmed}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!dsResp.ok) {
      const errText = await dsResp.text();
      return fail(c, 500, [
        { code: 'llm_error', message: `DeepSeek HTTP ${dsResp.status}`, details: errText.slice(0, 300) },
      ]);
    }

    const dsData = await dsResp.json<{ choices: Array<{ message: { content: string } }> }>();
    const dsContent = dsData.choices?.[0]?.message?.content ?? '{}';
    let extracted: ExtractedDoc;
    try {
      extracted = JSON.parse(dsContent);
    } catch {
      return fail(c, 500, [{ code: 'llm_bad_json', message: dsContent.slice(0, 200) }]);
    }

    // 5. Resolve operation_reference → operation_id
    let matchedOp: { id: string; reference: string; status: string; total_amount: number | null; currency: string | null } | null = null;
    if (extracted.operation_reference) {
      const row = await c.env.DB.prepare(
        `SELECT id, reference, status, total_amount, currency
           FROM operations
          WHERE reference = ? AND deleted_at IS NULL`
      ).bind(extracted.operation_reference).first<any>();
      if (row) matchedOp = row;
    }

    // 6. High-confidence auto-attach
    if (matchedOp && extracted.confidence >= 0.8) {
      const attachId = `att_${crypto.randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      const attachR2Key = `attachments/${matchedOp.id}/${fileId}-${safeName}`;
      await c.env.DOCS.put(attachR2Key, bytes, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' },
      });
      const attachUrl = `/api/attachment-files/${fileId}-${safeName}?op=${matchedOp.id}`;

      await c.env.DB.prepare(
        `INSERT INTO operation_attachments
           (id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
            issuer, file_url, parsed_from, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        attachId,
        matchedOp.id,
        extracted.direction,
        extracted.doc_type || 'other',
        extracted.doc_number,
        extracted.doc_date ? Math.floor(new Date(extracted.doc_date + 'T12:00:00Z').getTime() / 1000) : null,
        extracted.amount,
        extracted.currency,
        extracted.issuer,
        attachUrl,
        'inbox',
        extracted.notes?.slice(0, 500),
        now, now
      ).run();

      return ok(c, {
        mode: 'auto_attached',
        operation_id: matchedOp.id,
        operation_reference: matchedOp.reference,
        attachment_id: attachId,
        file_url: attachUrl,
        extracted,
      });
    }

    // 7. Low confidence or no match → return candidates + prefill for new-op creation
    const candidates = await c.env.DB.prepare(
      `SELECT o.id, o.reference, o.status, o.operation_date, o.total_amount, o.currency,
              p.trade_name AS partner_name
         FROM operations o
         LEFT JOIN partners p ON p.id = o.partner_id
        WHERE o.deleted_at IS NULL
        ORDER BY o.operation_date DESC
        LIMIT 30`
    ).all();

    // Build prefill block so UI can show one-click Create stub & attach
    const prefill = await buildPrefill(c.env, extracted, r2Key, filename, mimeType, bytes.length);

    return ok(c, {
      mode: matchedOp ? 'low_confidence' : 'no_match',
      r2_key: r2Key,
      filename,
      file_size: bytes.length,
      file_mime: mimeType,
      extracted,
      suggestion: matchedOp,
      candidates: candidates.results ?? [],
      prefill,
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/operations/create-from-document
// Body: {
//   operation_type: 'sale'|'purchase'|'transfer',
//   operation_date: unixSec,
//   partner_id?: string | null,            // sale/purchase non-factory
//   manufacturer_id?: string | null,       // purchase from factory
//   our_company_id: string,                // required for all types
//   receiving_company_id?: string | null,  // transfer only
//   currency: string,                      // 3-letter ISO
//   total_amount?: number | null,          // optional shown total
//   warehouse_from_id?: string | null,
//   warehouse_to_id?: string | null,
//   notes?: string | null,
//   // Document attach payload — comes back from upload-document response
//   r2_key: string,                        // existing R2 key from upload
//   filename: string,
//   file_mime: string,
//   // Extracted doc metadata (optional, used for operation_attachments row)
//   doc_type?: string,
//   doc_number?: string | null,
//   doc_date?: string | null,
//   issuer?: string | null,
//   direction?: 'incoming' | 'outgoing',
// }
//
// Creates a draft operation (no line_items — stub mode) and attaches the
// already-uploaded R2 file to it. Returns the new operation_id + reference
// so the UI can navigate to it.
// =============================================================================
operationDocs.post('/create-from-document', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  // Validate required fields
  if (!body.operation_type || !['sale', 'purchase', 'transfer'].includes(body.operation_type)) {
    return fail(c, 422, [{ code: 'invalid_operation_type', message: 'operation_type must be sale|purchase|transfer' }]);
  }
  if (!body.our_company_id || typeof body.our_company_id !== 'string') {
    return fail(c, 422, [{ code: 'invalid_our_company_id', message: 'our_company_id required' }]);
  }
  if (!body.currency || typeof body.currency !== 'string' || body.currency.length !== 3) {
    return fail(c, 422, [{ code: 'invalid_currency', message: 'currency must be 3-letter ISO code' }]);
  }
  if (!body.operation_date || typeof body.operation_date !== 'number') {
    return fail(c, 422, [{ code: 'invalid_date', message: 'operation_date required (unix seconds)' }]);
  }
  if (!body.r2_key || !body.filename) {
    return fail(c, 422, [{ code: 'missing_file_ref', message: 'r2_key and filename required to attach document' }]);
  }

  // Per-type validation
  if (body.operation_type === 'sale') {
    if (!body.partner_id) {
      return fail(c, 422, [{ code: 'partner_required', message: 'partner_id required for sale operations' }]);
    }
  } else if (body.operation_type === 'purchase') {
    if (!body.manufacturer_id && !body.partner_id) {
      return fail(c, 422, [{ code: 'counterparty_required', message: 'manufacturer_id or partner_id required for purchase' }]);
    }
  } else if (body.operation_type === 'transfer') {
    if (!body.receiving_company_id) {
      return fail(c, 422, [{ code: 'receiving_required', message: 'receiving_company_id required for transfer' }]);
    }
    if (body.our_company_id === body.receiving_company_id) {
      return fail(c, 422, [{ code: 'same_company', message: 'our_company_id and receiving_company_id must differ' }]);
    }
  }

  // Validate FKs
  const company = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM companies WHERE id = ? AND deleted_at IS NULL'
  ).bind(body.our_company_id).first<{ id: string; abbreviation: string }>();
  if (!company) {
    return fail(c, 404, [{ code: 'company_not_found', message: `our_company_id ${body.our_company_id} does not exist` }]);
  }

  let partnerSubtype: string | null = null;
  if (body.partner_id) {
    const p = await c.env.DB.prepare(
      'SELECT id, partner_subtype FROM partners WHERE id = ? AND deleted_at IS NULL'
    ).bind(body.partner_id).first<{ id: string; partner_subtype: string | null }>();
    if (!p) return fail(c, 404, [{ code: 'partner_not_found', message: `partner_id ${body.partner_id} does not exist` }]);
    partnerSubtype = p.partner_subtype;
  }
  // Derive operation track. Service-only counterparties (auditors, logistics,
  // agencies — see migration 0034) flip to 'service' track so the operation
  // page renders Service provided / Paid chips instead of the goods toolbar.
  const operationTrack: 'goods' | 'service' = partnerSubtype ? 'service' : 'goods';
  if (body.manufacturer_id) {
    const m = await c.env.DB.prepare('SELECT id FROM manufacturers WHERE id = ?').bind(body.manufacturer_id).first();
    if (!m) return fail(c, 404, [{ code: 'manufacturer_not_found', message: `manufacturer_id ${body.manufacturer_id} does not exist` }]);
  }
  if (body.receiving_company_id) {
    const r = await c.env.DB.prepare('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL').bind(body.receiving_company_id).first();
    if (!r) return fail(c, 404, [{ code: 'receiving_company_not_found', message: `receiving_company_id does not exist` }]);
  }
  if (body.warehouse_from_id) {
    const w = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(body.warehouse_from_id).first();
    if (!w) return fail(c, 404, [{ code: 'warehouse_not_found', message: `warehouse_from_id does not exist` }]);
  }
  if (body.warehouse_to_id) {
    const w = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?').bind(body.warehouse_to_id).first();
    if (!w) return fail(c, 404, [{ code: 'warehouse_not_found', message: `warehouse_to_id does not exist` }]);
  }

  // Issue reference
  const refResult = await issueOperationReference(
    c.env.DB,
    body.our_company_id,
    body.operation_date
  );
  if (!refResult) {
    return fail(c, 500, [{ code: 'reference_failed', message: `No entity mapping for company ${body.our_company_id}` }]);
  }

  const operationId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const totalAmount = typeof body.total_amount === 'number' ? body.total_amount : null;
  const stubNote = body.notes
    ? `${body.notes}\n\n[Created from uploaded document: ${body.filename}]`
    : `[Stub operation created from uploaded document: ${body.filename}. Add line items manually.]`;

  // Insert operation (stub — no line_items)
  const insertOpStmt = c.env.DB.prepare(`
    INSERT INTO operations (
      id, contract_id, operation_date, operation_type,
      partner_id, our_company_id, receiving_company_id, manufacturer_id,
      warehouse_from_id, warehouse_to_id,
      reference, status,
      price_type_id, currency, fx_rate_to_usd,
      total_amount, total_usd_equiv,
      incoterms, notes, vat_rate,
      dei_layer, legal_seller_id,
      operation_track,
      created_at, updated_at, deleted_at
    ) VALUES (
      ?, NULL, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, 'draft',
      NULL, ?, NULL,
      ?, NULL,
      NULL, ?, 0,
      0, NULL,
      ?,
      ?, ?, NULL
    )
  `).bind(
    operationId,
    body.operation_date,
    body.operation_type,
    body.partner_id ?? null,
    body.our_company_id,
    body.receiving_company_id ?? null,
    body.manufacturer_id ?? null,
    body.warehouse_from_id ?? null,
    body.warehouse_to_id ?? null,
    refResult.reference,
    body.currency,
    totalAmount,
    stubNote,
    operationTrack,
    now,
    now,
  );

  // Copy the R2 file from the temporary upload key to the operation's attachments folder
  const r2Obj = await c.env.DOCS.get(body.r2_key);
  if (!r2Obj) {
    return fail(c, 404, [{ code: 'file_not_in_r2', message: `Uploaded file no longer available at ${body.r2_key}` }]);
  }
  const fileBytes = new Uint8Array(await r2Obj.arrayBuffer());
  const safeName = sanitizeFilename(body.filename);
  const fileId = crypto.randomUUID();
  const attachR2Key = `attachments/${operationId}/${fileId}-${safeName}`;
  await c.env.DOCS.put(attachR2Key, fileBytes, {
    httpMetadata: { contentType: body.file_mime || 'application/octet-stream' },
  });
  const attachUrl = `/api/attachment-files/${fileId}-${safeName}?op=${operationId}`;
  const attachId = `att_${crypto.randomUUID()}`;

  const insertAttachStmt = c.env.DB.prepare(
    `INSERT INTO operation_attachments
       (id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
        issuer, file_url, parsed_from, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    attachId,
    operationId,
    body.direction || 'incoming',
    body.doc_type || 'other',
    body.doc_number ?? null,
    body.doc_date ? Math.floor(new Date(body.doc_date + 'T12:00:00Z').getTime() / 1000) : null,
    totalAmount,
    body.currency,
    body.issuer ?? null,
    attachUrl,
    'create_from_doc',
    `Document used to create this stub operation: ${body.filename}`.slice(0, 500),
    now,
    now,
  );

  try {
    await c.env.DB.batch([insertOpStmt, insertAttachStmt]);
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to create stub operation',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  return ok(c, {
    operation: {
      id: operationId,
      reference: refResult.reference,
      operation_type: body.operation_type,
      operation_date: body.operation_date,
      partner_id: body.partner_id ?? null,
      manufacturer_id: body.manufacturer_id ?? null,
      our_company_id: body.our_company_id,
      our_company_abbr: company.abbreviation,
      receiving_company_id: body.receiving_company_id ?? null,
      currency: body.currency,
      total_amount: totalAmount,
      status: 'draft',
      warehouse_from_id: body.warehouse_from_id ?? null,
      warehouse_to_id: body.warehouse_to_id ?? null,
      stub: true,
    },
    attachment: {
      id: attachId,
      file_url: attachUrl,
      filename: body.filename,
    },
    warnings: ['stub_operation: created without line_items — add positions manually from the operation page'],
  }, [`Operation ${refResult.reference} created as draft stub and document attached`]);
});

export default operationDocs;
