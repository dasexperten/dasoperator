// =============================================================================
// /api/document-extractions — review queue for parsed documents
// =============================================================================
//
// Endpoints:
//   GET    /                            — list pending (filterable)
//   GET    /:id                         — full diff-view payload
//   PATCH  /:id/header                  — operator edits header field value
//   PATCH  /:id/line-item/:idx          — operator edits a line item
//   POST   /:id/approve                 — commit to target table
//   POST   /:id/reject                  — discard
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import { recordAlias } from '../lib/verification-pipeline';

const documentExtractions = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET / — list pending extractions
// =============================================================================
documentExtractions.get('/', async (c) => {
  try {
    const status = c.req.query('status') || 'pending_review';
    const source = c.req.query('source');
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50)));

    let where = `deleted_at IS NULL AND status = ?`;
    const params: any[] = [status];
    if (source) { where += ` AND source = ?`; params.push(source); }

    const rows = await c.env.DB.prepare(
      `SELECT id, source, document_kind, filename, overall_confidence, status,
              target_table, target_action, created_at,
              json_extract(validation_results_json, '$.errors_count') AS errors_count,
              json_extract(validation_results_json, '$.warnings_count') AS warnings_count
         FROM document_extractions
        WHERE ${where}
        ORDER BY created_at DESC LIMIT ?`
    ).bind(...params, limit).all();

    return ok(c, { extractions: rows.results || [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// GET /counts — summary for dashboard widgets
// =============================================================================
documentExtractions.get('/counts', async (c) => {
  try {
    const totals = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM document_extractions
        WHERE deleted_at IS NULL GROUP BY status`
    ).all<{ status: string; n: number }>();
    const out: Record<string, number> = { pending_review: 0, approved: 0, rejected: 0, superseded: 0 };
    for (const r of totals.results || []) out[r.status] = r.n;
    return ok(c, { counts: out });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// GET /:id — full extraction with diff-view data
// =============================================================================
documentExtractions.get('/:id/file', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT r2_key, filename, file_mime FROM document_extractions WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ r2_key: string; filename: string; file_mime: string }>();
    if (!row || !row.r2_key) return fail(c, 404, [{ code: 'not_found', message: `No file for extraction ${id}` }]);
    const obj = await c.env.DOCS.get(row.r2_key);
    if (!obj) return fail(c, 404, [{ code: 'file_gone', message: `File missing in storage for ${id}` }]);
    const headers = new Headers();
    headers.set('Content-Type', row.file_mime || 'application/pdf');
    headers.set('Content-Disposition', `inline; filename="${(row.filename || 'document').replace(/[^\w\d.\-]/g, '_')}"`);
    headers.set('Cache-Control', 'private, max-age=300');
    return new Response(obj.body, { headers });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

documentExtractions.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT * FROM document_extractions WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<any>();
    if (!row) return fail(c, 404, [{ code: 'not_found', message: `Extraction ${id} not found` }]);

    const parsed = {
      ...row,
      raw_extract: row.raw_extract_json ? JSON.parse(row.raw_extract_json) : null,
      header_fields: row.header_fields_json ? JSON.parse(row.header_fields_json) : {},
      line_items: row.line_items_json ? JSON.parse(row.line_items_json) : [],
      validation: row.validation_results_json ? JSON.parse(row.validation_results_json) : null,
    };
    delete parsed.raw_extract_json;
    delete parsed.header_fields_json;
    delete parsed.line_items_json;
    delete parsed.validation_results_json;

    return ok(c, { extraction: parsed });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /:id/header — operator overrides a header field value
// Body: { field: string, value: string | number | null }
// =============================================================================
documentExtractions.patch('/:id/header', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json() as { field: string; value: any };
    if (!body.field) return fail(c, 422, [{ code: 'missing_field', message: 'field required' }]);

    const row = await c.env.DB.prepare(
      `SELECT header_fields_json FROM document_extractions WHERE id = ? AND deleted_at IS NULL AND status = 'pending_review'`
    ).bind(id).first<{ header_fields_json: string }>();
    if (!row) return fail(c, 404, [{ code: 'not_found_or_locked', message: 'Extraction not found or already reviewed' }]);

    const headers = JSON.parse(row.header_fields_json || '{}');
    if (!headers[body.field]) headers[body.field] = { value: null, raw: null, confidence: 0, source: null, alternatives: [], needs_review: false };
    const previous = headers[body.field].value;
    headers[body.field].value = body.value;
    headers[body.field].confidence = 1.0;       // operator-set = certain
    headers[body.field].source = 'operator';
    headers[body.field].needs_review = false;

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE document_extractions SET header_fields_json = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(headers), now, id).run();

    return ok(c, { field: body.field, previous, value: body.value });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /:id/line-item/:idx — operator overrides a line item field
// Body: { field: 'product_id'|'qty'|'unit_price'|'line_amount'|'description', value: any }
// =============================================================================
documentExtractions.patch('/:id/line-item/:idx', async (c) => {
  try {
    const id = c.req.param('id');
    const idx = parseInt(c.req.param('idx'), 10);
    const body = await c.req.json() as { field: string; value: any };

    const row = await c.env.DB.prepare(
      `SELECT line_items_json FROM document_extractions WHERE id = ? AND deleted_at IS NULL AND status = 'pending_review'`
    ).bind(id).first<{ line_items_json: string }>();
    if (!row) return fail(c, 404, [{ code: 'not_found_or_locked', message: 'Extraction not found or already reviewed' }]);

    const items = JSON.parse(row.line_items_json || '[]');
    if (idx < 0 || idx >= items.length) return fail(c, 422, [{ code: 'idx_out_of_range', message: `idx ${idx} out of ${items.length}` }]);

    const previous = items[idx][body.field];
    items[idx][body.field] = body.value;
    if (body.field === 'product_id') {
      items[idx]['product_id_source'] = 'operator';
      items[idx]['product_id_confidence'] = 1.0;
      items[idx]['needs_review'] = false;
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE document_extractions SET line_items_json = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(items), now, id).run();

    return ok(c, { idx, field: body.field, previous, value: body.value });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /:id/reject — discard the extraction
// =============================================================================
documentExtractions.post('/:id/reject', async (c) => {
  try {
    const id = c.req.param('id');
    let body: { reason?: string } = {};
    try { body = await c.req.json(); } catch {}

    const now = Math.floor(Date.now() / 1000);
    const r = await c.env.DB.prepare(
      `UPDATE document_extractions
          SET status = 'rejected', reviewed_at = ?, updated_at = ?, rejection_reason = ?
        WHERE id = ? AND status = 'pending_review' AND deleted_at IS NULL`
    ).bind(now, now, body.reason || null, id).run();

    if (r.meta.changes === 0) return fail(c, 404, [{ code: 'not_found_or_locked', message: 'Extraction not found or already reviewed' }]);
    return ok(c, { id, status: 'rejected' });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /:id/approve — commit to target table
// =============================================================================
// On approval:
//   1. Read extraction
//   2. Dispatch to target-specific commit handler based on target_table + target_action
//   3. Record aliases for every resolved entity (so future parses use learned mapping)
//   4. Mark as 'approved' with reviewed_at
// =============================================================================
documentExtractions.post('/:id/approve', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT * FROM document_extractions WHERE id = ? AND deleted_at IS NULL AND status = 'pending_review'`
    ).bind(id).first<any>();
    if (!row) return fail(c, 404, [{ code: 'not_found_or_locked', message: 'Extraction not found or already reviewed' }]);

    const headers = JSON.parse(row.header_fields_json || '{}');
    const lineItems = JSON.parse(row.line_items_json || '[]');

    let commitResult: { target_id: string; reference?: string };

    if (row.target_table === 'operations' && row.target_action === 'create') {
      commitResult = await commitOperationCreate(c.env, row, headers, lineItems);
    } else if (row.target_table === 'bank_transactions' && row.target_action === 'create') {
      commitResult = await commitBankTransactionsCreate(c.env, row, headers, lineItems);
    } else if (row.target_table === 'operations' && row.target_action === 'attach') {
      commitResult = await commitOperationAttach(c.env, row, headers);
    } else {
      return fail(c, 422, [{ code: 'unsupported_target', message: `target_table=${row.target_table} target_action=${row.target_action}` }]);
    }

    // Record aliases for learning
    for (const [_k, fr] of Object.entries(headers) as Array<[string, any]>) {
      if (fr && fr.value && fr.raw && fr.source && fr.source !== 'operator' && fr.source !== 'sku_hint' && fr.source !== 'inn_match' && fr.source !== 'iban_match') {
        // Only record fuzzy/keyword matches as aliases (precise matches don't need to be learned)
        if (_k === 'partner_id' || _k === 'partner') {
          await recordAlias(c.env, 'partner', fr.raw, fr.value, fr.confidence);
        } else if (_k === 'our_company_id' || _k === 'company') {
          await recordAlias(c.env, 'company', fr.raw, fr.value, fr.confidence);
        }
      }
      if (fr && fr.value && fr.raw && fr.source === 'operator') {
        // Operator override is a STRONG signal — learn unconditionally
        if (_k === 'partner_id' || _k === 'partner') {
          await recordAlias(c.env, 'partner', fr.raw, fr.value, 1.0);
        } else if (_k === 'our_company_id' || _k === 'company') {
          await recordAlias(c.env, 'company', fr.raw, fr.value, 1.0);
        }
      }
    }
    for (const li of lineItems) {
      if (li.product_id && li.description) {
        // Always learn from line items — operator confirmed by approving
        await recordAlias(c.env, 'product', li.description, li.product_id,
          li.product_id_source === 'operator' ? 1.0 : (li.product_id_confidence || 0.8));
      }
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE document_extractions
          SET status = 'approved', target_id = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?`
    ).bind(commitResult.target_id, now, now, id).run();

    return ok(c, { id, status: 'approved', target_id: commitResult.target_id, reference: commitResult.reference });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// Commit handlers — wired per target_table + target_action
// =============================================================================
async function commitOperationCreate(
  env: Env,
  row: any,
  headers: Record<string, any>,
  lineItems: Array<any>
): Promise<{ target_id: string; reference?: string }> {
  // Resolve target params from headers
  const operationType = headers.operation_type?.value;
  const partnerId = headers.partner_id?.value;
  const manufacturerId = headers.manufacturer_id?.value;
  const ourCompanyId = headers.our_company_id?.value;
  const contractId = headers.contract_id?.value || null;
  const receivingCompanyId = headers.receiving_company_id?.value;
  const currency = headers.currency?.value;
  const totalAmount = headers.total_amount?.value;
  const operationDate = headers.operation_date?.value;
  const docNumber = headers.doc_number?.value;
  const docDate = headers.doc_date?.value;
  const issuer = headers.issuer?.value;
  const direction = headers.direction?.value || 'incoming';

  if (!operationType || !ourCompanyId || !currency || !operationDate) {
    throw new Error('Missing required header fields (operation_type, our_company_id, currency, operation_date)');
  }

  // Pre-validate FKs to give a clear error instead of opaque SQLITE_CONSTRAINT
  const fkChecks: Array<{ name: string; sql: string; value: any }> = [
    { name: 'our_company_id', sql: 'SELECT 1 FROM companies WHERE id = ? AND deleted_at IS NULL', value: ourCompanyId },
  ];
  if (partnerId) fkChecks.push({ name: 'partner_id', sql: 'SELECT 1 FROM partners WHERE id = ? AND deleted_at IS NULL', value: partnerId });
  if (manufacturerId) fkChecks.push({ name: 'manufacturer_id', sql: 'SELECT 1 FROM manufacturers WHERE id = ?', value: manufacturerId });
  if (contractId) fkChecks.push({ name: 'contract_id', sql: 'SELECT 1 FROM contracts WHERE id = ? AND deleted_at IS NULL', value: contractId });
  if (receivingCompanyId) fkChecks.push({ name: 'receiving_company_id', sql: 'SELECT 1 FROM companies WHERE id = ? AND deleted_at IS NULL', value: receivingCompanyId });
  for (const li of lineItems) {
    if (li.product_id) {
      fkChecks.push({ name: `line_item_product:${li.product_id}`, sql: 'SELECT 1 FROM products WHERE id = ? AND deleted_at IS NULL', value: li.product_id });
    }
  }
  const fkErrors: string[] = [];
  for (const chk of fkChecks) {
    const found = await env.DB.prepare(chk.sql).bind(chk.value).first();
    if (!found) fkErrors.push(`${chk.name}=${chk.value} does not exist`);
  }
  if (fkErrors.length > 0) {
    throw new Error(`Cannot commit — referenced records not found: ${fkErrors.join('; ')}`);
  }


  const { issueOperationReference } = await import('../lib/operation-reference');
  const refResult = await issueOperationReference(env.DB, {
    operationType,
    ourCompanyId,
    manufacturerId: manufacturerId || null,
    partnerId: partnerId || null,
    operationDateUnix: operationDate,
  });
  if (!refResult) throw new Error(`No reference mapping for ${operationType} (company=${ourCompanyId}, mfr=${manufacturerId})`);

  const operationId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const stubNote = `[Created from approved extraction ${row.id}, document: ${row.filename}]`;

  const stmts: any[] = [];
  stmts.push(env.DB.prepare(
    `INSERT INTO operations (
       id, contract_id, operation_date, operation_type,
       partner_id, our_company_id, receiving_company_id, manufacturer_id,
       warehouse_from_id, warehouse_to_id,
       reference, status,
       price_type_id, currency, fx_rate_to_usd,
       total_amount, total_usd_equiv,
       incoterms, notes, vat_rate,
       dei_layer, legal_seller_id,
       created_at, updated_at, deleted_at
     ) VALUES (
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       NULL, NULL,
       ?, 'draft',
       NULL, ?, NULL,
       ?, NULL,
       NULL, ?, 0,
       0, NULL,
       ?, ?, NULL
     )`
  ).bind(
    operationId, contractId, operationDate, operationType,
    partnerId ?? null, ourCompanyId, receivingCompanyId ?? null, manufacturerId ?? null,
    refResult.reference,
    currency, totalAmount,
    stubNote,
    now, now
  ));

  // Attach the document
  if (row.r2_key) {
    const r2Obj = await env.DOCS.get(row.r2_key);
    if (r2Obj) {
      const fileBytes = new Uint8Array(await r2Obj.arrayBuffer());
      const safeName = (row.filename || 'file').replace(/[^\w\d.\-]/g, '_').slice(0, 120);
      const fileId = crypto.randomUUID();
      const attachR2Key = `attachments/${operationId}/${fileId}-${safeName}`;
      await env.DOCS.put(attachR2Key, fileBytes, {
        httpMetadata: { contentType: row.file_mime || 'application/octet-stream' },
      });
      const attachUrl = `/api/attachment-files/${encodeURIComponent(attachR2Key)}`;
      const attachId = `att_${crypto.randomUUID()}`;
      stmts.push(env.DB.prepare(
        `INSERT INTO operation_attachments
           (id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
            issuer, file_url, parsed_from, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
      ).bind(
        attachId, operationId, (operationType === 'sale' ? 'outgoing' : 'incoming'), row.document_kind || 'other',
        docNumber ?? null, docDate ? Math.floor(new Date(docDate + 'T12:00:00Z').getTime() / 1000) : null,
        totalAmount, currency, issuer ?? null, attachUrl,
        `Approved via Document Verification Pipeline (${row.id})`.slice(0, 500),
        now, now
      ));
    }
  }

  // Line items
  for (const li of lineItems) {
    if (!li.product_id) continue;
    const qty = Number(li.qty) || 0;
    const unitPrice = Number(li.unit_price) || 0;
    const lineAmount = typeof li.line_amount === 'number' && li.line_amount > 0
      ? Number(li.line_amount)
      : qty * unitPrice;
    const cartons = Number(li.cartons) || 0;
    const liId = `li_${crypto.randomUUID()}`;
    stmts.push(env.DB.prepare(
      `INSERT INTO line_items
         (id, operation_id, product_id, item_description, qty, cartons, inner_boxes,
          unit_price, discount_pct, unit_price_after_disc, line_amount,
          currency, line_usd_equiv, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, NULL, ?, ?)`
    ).bind(
      liId, operationId, li.product_id,
      (li.description || '').slice(0, 500),
      qty, cartons,
      unitPrice, unitPrice, lineAmount,
      currency, now, now
    ));
  }

  await env.DB.batch(stmts);

  // Auto-allocate any awaiting bank_tx that match this new operation
  // (forward trigger: invoice arrived → attach parked payments)
  try {
    const { allocateAwaitingTxToOperation } = await import('../lib/bank-tx-allocator');
    await allocateAwaitingTxToOperation(env, operationId);
  } catch (e) {
    console.error('[document-extractions] allocator failed (non-fatal):', e);
  }

  return { target_id: operationId, reference: refResult.reference };
}

async function commitOperationAttach(
  env: Env,
  row: any,
  headers: Record<string, any>
): Promise<{ target_id: string }> {
  const opId = headers.operation_id?.value;
  if (!opId) throw new Error('operation_id required for attach action');
  // Implementation parallels commitOperationCreate's attachment step, against existing op
  const now = Math.floor(Date.now() / 1000);
  if (row.r2_key) {
    const r2Obj = await env.DOCS.get(row.r2_key);
    if (r2Obj) {
      const fileBytes = new Uint8Array(await r2Obj.arrayBuffer());
      const safeName = (row.filename || 'file').replace(/[^\w\d.\-]/g, '_').slice(0, 120);
      const fileId = crypto.randomUUID();
      const attachR2Key = `attachments/${opId}/${fileId}-${safeName}`;
      await env.DOCS.put(attachR2Key, fileBytes, {
        httpMetadata: { contentType: row.file_mime || 'application/octet-stream' },
      });
      const attachUrl = `/api/attachment-files/${encodeURIComponent(attachR2Key)}`;
      const attachId = `att_${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO operation_attachments
           (id, operation_id, direction, kind, doc_number, doc_date, amount, currency,
            issuer, file_url, parsed_from, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
      ).bind(
        attachId, opId,
        headers.direction?.value || 'incoming',
        row.document_kind || 'other',
        headers.doc_number?.value ?? null,
        headers.doc_date?.value ? Math.floor(new Date(headers.doc_date.value + 'T12:00:00Z').getTime() / 1000) : null,
        headers.total_amount?.value ?? null,
        headers.currency?.value ?? null,
        headers.issuer?.value ?? null,
        attachUrl,
        `Approved via Document Verification Pipeline (${row.id})`.slice(0, 500),
        now, now
      ).run();
    }
  }
  return { target_id: opId };
}

async function commitBankTransactionsCreate(
  _env: Env,
  _row: any,
  _headers: Record<string, any>,
  _lineItems: Array<any>
): Promise<{ target_id: string }> {
  throw new Error('bank_transactions commit not yet wired — bank statements parse to bank_transactions table; pipeline integration pending');
}

export default documentExtractions;
