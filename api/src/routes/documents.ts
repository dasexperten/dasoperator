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

  const outcome = await issueDocuments(parsed.data.operation_id, c.env, c.req.url);

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

export default documents;
