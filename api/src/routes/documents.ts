// =============================================================================
// /api/documents — invoicer-backed.
// POST /issue runs the full skill pipeline (data-loader → selectors →
// validators → renderers → R2 → D1) and returns the list of issued documents.
// GET /:id/download streams the .docx blob from R2.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueDocuments } from '../skills/invoicer';

const documents = new Hono<{ Bindings: Env }>();

const issueSchema = z.object({
  operation_id: z.string().min(1),
  document_type: z.enum(['CI', 'PL', 'IS', 'auto']).default('auto'),
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

  const outcome = await issueDocuments(
    parsed.data.operation_id, parsed.data.document_type, c.env, c.req.url,
  );

  if (!outcome.success) {
    return fail(c, outcome.status, [{
      code: outcome.error.code,
      message: outcome.error.message,
      ...(outcome.error.missing ? { details: { missing: outcome.error.missing } } : {}),
      ...(outcome.error.details ? { details: outcome.error.details } : {}),
    }], outcome.warnings);
  }

  return ok(c, {
    documents: outcome.documents,
    warnings: outcome.warnings,
    operation_status_after: outcome.operation_status_after,
  }, outcome.warnings.length > 0 ? outcome.warnings : []);
});

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
