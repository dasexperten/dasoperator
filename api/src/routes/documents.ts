// =============================================================================
// /api/documents — invoicer-backed.
// GET /                  list documents (filterable by operation_id, partner_id, type)
// POST /issue            runs the full skill pipeline; engine decides which
//                        documents to emit (CI / PL / IS-V1 / IS-V2 or any
//                        combination).
// GET /:id/download      streams the .docx blob from R2.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueDocuments } from '../skills/invoicer';

const documents = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// GET /api/documents
// Query params (all optional):
//   operation_id  filter by operation
//   partner_id    filter by partner
//   type          filter by document_type (CI | PL | IS | contract | annex | addendum | other)
//   status        filter by status (draft | issued | cancelled)
//   limit         max rows (default 100, max 500)
// -----------------------------------------------------------------------------
documents.get('/', async (c) => {
  const operationId = c.req.query('operation_id');
  const partnerId = c.req.query('partner_id');
  const docType = c.req.query('type');
  const status = c.req.query('status');
  const limitRaw = c.req.query('limit');

  let limit = 100;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fail(c, 422, [{ code: 'invalid_limit', message: 'limit must be a positive integer' }]);
    }
    limit = Math.min(parsed, 500);
  }

  const where: string[] = ['d.deleted_at IS NULL'];
  const binds: (string | number)[] = [];

  if (operationId) {
    where.push('d.operation_id = ?');
    binds.push(operationId);
  }
  if (partnerId) {
    where.push('d.partner_id = ?');
    binds.push(partnerId);
  }
  if (docType) {
    where.push('d.document_type = ?');
    binds.push(docType);
  }
  if (status) {
    where.push('d.status = ?');
    binds.push(status);
  }

  const sql = `
    SELECT
      d.id,
      d.document_number,
      d.document_type,
      d.operation_id,
      d.issuer_id,
      d.partner_id,
      d.contract_ref,
      d.document_date,
      d.currency,
      d.total_amount,
      d.pdf_r2_url,
      d.owner_name,
      d.mandatory_level,
      d.when_ready,
      d.status,
      d.created_at,
      d.updated_at,
      c.legal_name AS issuer_name,
      p.legal_name AS partner_name
    FROM documents d
    LEFT JOIN companies c ON c.id = d.issuer_id
    LEFT JOIN partners  p ON p.id = d.partner_id
    WHERE ${where.join(' AND ')}
    ORDER BY d.document_date DESC, d.created_at DESC
    LIMIT ?
  `;
  binds.push(limit);

  const stmt = c.env.DB.prepare(sql).bind(...binds);
  const rows = await stmt.all<{
    id: string;
    document_number: string;
    document_type: string;
    operation_id: string | null;
    issuer_id: string;
    partner_id: string | null;
    contract_ref: string | null;
    document_date: number;
    currency: string | null;
    total_amount: number | null;
    pdf_r2_url: string | null;
    owner_name: string | null;
    mandatory_level: string | null;
    when_ready: string | null;
    status: string;
    created_at: number;
    updated_at: number;
    issuer_name: string | null;
    partner_name: string | null;
  }>();

  return ok(c, {
    documents: rows.results ?? [],
    count: rows.results?.length ?? 0,
    filters: {
      operation_id: operationId ?? null,
      partner_id: partnerId ?? null,
      type: docType ?? null,
      status: status ?? null,
      limit,
    },
  });
});

// -----------------------------------------------------------------------------
// POST /api/documents/issue
// -----------------------------------------------------------------------------
const issueSchema = z.object({
  operation_id: z.string().min(1),
  types: z.array(z.enum(['CI', 'PL', 'IS-V1', 'IS-V2', 'UPD', 'TN'])).optional(),
});

documents.post('/issue', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const outcome = await issueDocuments(parsed.data.operation_id, c.env, c.req.url, parsed.data.types);

  if (!outcome.success) {
    return fail(c, outcome.status, [{
      code: outcome.error.code,
      message: outcome.error.message,
      ...(outcome.error.missing ? { details: { missing: outcome.error.missing } } : {}),
      ...(outcome.error.details ? { details: outcome.error.details } : {}),
    }], outcome.warnings);
  }

  return ok(c, {
    operation_id: outcome.operation_id,
    operation_status_after: outcome.operation_status_after,
    documents: outcome.documents,
    warnings: outcome.warnings,
  }, outcome.warnings);
});

// -----------------------------------------------------------------------------
// GET /api/documents/:id/download
// -----------------------------------------------------------------------------
documents.get('/:id/download', async (c) => {
  const docId = c.req.param('id');

  const doc = await c.env.DB.prepare(
    `SELECT id, document_number, document_type, pdf_r2_url
       FROM documents WHERE id = ? AND deleted_at IS NULL`
  ).bind(docId).first<{
    id: string;
    document_number: string;
    document_type: string;
    pdf_r2_url: string | null;
  }>();

  if (!doc) {
    return fail(c, 404, [{ code: 'document_not_found', message: `Document ${docId} not found` }]);
  }
  if (!doc.pdf_r2_url) {
    return fail(c, 404, [{
      code: 'document_no_object',
      message: `Document ${docId} has no R2 object key`,
    }]);
  }

  const obj = await c.env.DOCS.get(doc.pdf_r2_url);
  if (!obj) {
    return fail(c, 404, [{
      code: 'r2_object_missing',
      message: `R2 object ${doc.pdf_r2_url} not found`,
    }]);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${doc.document_number}.docx"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
});

// -----------------------------------------------------------------------------
// GET /api/documents/:id/file/:filename
// Same as /download but with the filename baked into the URL path so that
// callers fetching the URL (e.g. Apps Script's UrlFetchApp) can derive the
// correct attachment name from the last path segment.
// `:filename` is purely cosmetic — the actual file is resolved by `:id`.
// -----------------------------------------------------------------------------
documents.get('/:id/file/:filename', async (c) => {
  const docId = c.req.param('id');

  const doc = await c.env.DB.prepare(
    `SELECT id, document_number, document_type, pdf_r2_url
       FROM documents WHERE id = ? AND deleted_at IS NULL`
  ).bind(docId).first<{
    id: string;
    document_number: string;
    document_type: string;
    pdf_r2_url: string | null;
  }>();

  if (!doc) {
    return fail(c, 404, [{ code: 'document_not_found', message: `Document ${docId} not found` }]);
  }
  if (!doc.pdf_r2_url) {
    return fail(c, 404, [{
      code: 'document_no_object',
      message: `Document ${docId} has no R2 object key`,
    }]);
  }

  const obj = await c.env.DOCS.get(doc.pdf_r2_url);
  if (!obj) {
    return fail(c, 404, [{
      code: 'r2_object_missing',
      message: `R2 object ${doc.pdf_r2_url} not found`,
    }]);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${doc.document_number}.docx"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
});
// Lazy-converts the .docx to PDF via CloudConvert on first request.
// Result is cached in R2 (pdf_converted_r2_url). Subsequent requests hit cache.
// Requires CLOUDCONVERT_API_KEY secret on the Worker.
// -----------------------------------------------------------------------------
documents.get('/:id/pdf', async (c) => {
  const docId = c.req.param('id');
  const env = c.env as typeof c.env & { CLOUDCONVERT_API_KEY?: string };

  if (!env.CLOUDCONVERT_API_KEY) {
    return fail(c, 503, [{ code: 'pdf_unavailable', message: 'PDF conversion is not configured on this Worker (CLOUDCONVERT_API_KEY missing)' }]);
  }

  const doc = await c.env.DB.prepare(
    `SELECT id, document_number, document_type, pdf_r2_url, pdf_converted_r2_url
       FROM documents WHERE id = ? AND deleted_at IS NULL`
  ).bind(docId).first<{
    id: string;
    document_number: string;
    document_type: string;
    pdf_r2_url: string | null;
    pdf_converted_r2_url: string | null;
  }>();

  if (!doc) {
    return fail(c, 404, [{ code: 'document_not_found', message: `Document ${docId} not found` }]);
  }
  if (!doc.pdf_r2_url) {
    return fail(c, 404, [{ code: 'document_no_object', message: `Document ${docId} has no source file` }]);
  }

  // --- Cache hit: PDF already converted ---
  if (doc.pdf_converted_r2_url) {
    const cached = await c.env.DOCS.get(doc.pdf_converted_r2_url);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${doc.document_number}.pdf"`,
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }
    // Cache miss (R2 object deleted externally) — fall through to reconvert
  }

  // --- Fetch source .docx from R2 ---
  const docxObj = await c.env.DOCS.get(doc.pdf_r2_url);
  if (!docxObj) {
    return fail(c, 404, [{ code: 'r2_object_missing', message: `Source file ${doc.pdf_r2_url} not found in R2` }]);
  }
  const docxBytes = await docxObj.arrayBuffer();

  // --- CloudConvert: upload → convert → download ---
  const CC_BASE = 'https://api.cloudconvert.com/v2';
  const ccHeaders = {
    'Authorization': `Bearer ${env.CLOUDCONVERT_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1. Create job (upload + convert + export in one request)
  const jobRes = await fetch(`${CC_BASE}/jobs`, {
    method: 'POST',
    headers: ccHeaders,
    body: JSON.stringify({
      tasks: {
        'upload-docx': {
          operation: 'import/upload',
        },
        'convert-to-pdf': {
          operation: 'convert',
          input: 'upload-docx',
          input_format: 'docx',
          output_format: 'pdf',
          engine: 'libreoffice',
        },
        'export-pdf': {
          operation: 'export/url',
          input: 'convert-to-pdf',
        },
      },
    }),
  });

  if (!jobRes.ok) {
    const err = await jobRes.text();
    return fail(c, 502, [{ code: 'cloudconvert_job_failed', message: `CloudConvert job creation failed: ${err.slice(0, 200)}` }]);
  }

  const jobData = await jobRes.json<{
    data: {
      id: string;
      tasks: Array<{ name: string; id: string; operation: string; status: string; result?: { files?: Array<{ url: string }> } }>;
    };
  }>();

  // 2. Find the upload task and upload docx
  const uploadTask = jobData.data.tasks.find((t) => t.name === 'upload-docx');
  if (!uploadTask) {
    return fail(c, 502, [{ code: 'cloudconvert_no_upload_task', message: 'Upload task not found in job response' }]);
  }

  // Get upload URL from the task (CloudConvert v2 uses form upload)
  const uploadInfoRes = await fetch(`${CC_BASE}/import/upload`, {
    method: 'POST',
    headers: ccHeaders,
    body: JSON.stringify({ task_id: uploadTask.id }),
  });

  // Actually CloudConvert v2 jobs API gives us a presigned form in the task itself
  // Re-fetch task to get the upload form
  const taskRes = await fetch(`${CC_BASE}/tasks/${uploadTask.id}`, {
    headers: { 'Authorization': `Bearer ${env.CLOUDCONVERT_API_KEY}` },
  });
  const taskData = await taskRes.json<{
    data: { result?: { form?: { url: string; parameters: Record<string, string> } } };
  }>();

  const form = taskData.data.result?.form;
  if (!form) {
    return fail(c, 502, [{ code: 'cloudconvert_no_upload_form', message: 'Upload form not available in task' }]);
  }

  // Build multipart form upload
  const formData = new FormData();
  for (const [k, v] of Object.entries(form.parameters)) {
    formData.append(k, v);
  }
  formData.append('file', new Blob([docxBytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }), `${doc.document_number}.docx`);

  const uploadRes = await fetch(form.url, { method: 'POST', body: formData });
  if (!uploadRes.ok && uploadRes.status !== 201 && uploadRes.status !== 204) {
    return fail(c, 502, [{ code: 'cloudconvert_upload_failed', message: `S3 upload failed: ${uploadRes.status}` }]);
  }

  // 3. Poll for job completion (max 30 seconds)
  const jobId = jobData.data.id;
  let pdfUrl: string | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${CC_BASE}/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${env.CLOUDCONVERT_API_KEY}` },
    });
    const pollData = await pollRes.json<{
      data: { status: string; tasks: Array<{ name: string; status: string; result?: { files?: Array<{ url: string }> } }> };
    }>();

    if (pollData.data.status === 'error') {
      return fail(c, 502, [{ code: 'cloudconvert_conversion_error', message: 'CloudConvert conversion failed' }]);
    }
    if (pollData.data.status === 'finished') {
      const exportTask = pollData.data.tasks.find((t) => t.name === 'export-pdf');
      pdfUrl = exportTask?.result?.files?.[0]?.url ?? null;
      break;
    }
  }

  if (!pdfUrl) {
    return fail(c, 504, [{ code: 'cloudconvert_timeout', message: 'PDF conversion timed out after 30 seconds' }]);
  }

  // 4. Download PDF from CloudConvert
  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) {
    return fail(c, 502, [{ code: 'cloudconvert_download_failed', message: 'Failed to download converted PDF' }]);
  }
  const pdfBytes = await pdfRes.arrayBuffer();

  // 5. Upload PDF to R2
  const pdfR2Key = doc.pdf_r2_url.replace(/\.docx$/, '.pdf');
  await c.env.DOCS.put(pdfR2Key, pdfBytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { source_docx: doc.pdf_r2_url, converted_via: 'cloudconvert' },
  });

  // 6. Update D1 with PDF key
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE documents SET pdf_converted_r2_url = ?, updated_at = ? WHERE id = ?`
  ).bind(pdfR2Key, now, docId).run();

  // 7. Return PDF to user
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${doc.document_number}.pdf"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
});

export default documents;
