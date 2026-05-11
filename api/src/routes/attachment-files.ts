import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

// =============================================================================
// Attachment file upload / serve
//
// Companion to /api/operations/:id/attachments (which stores metadata about a
// document tied to an operation). This route handles the BINARY file itself —
// upload to R2, fetch from R2.
//
// R2 layout:
//   /attachments/{operation_id}/{file_id}-{sanitized_filename}
//
// Returned URL pattern:
//   https://<worker>/api/attachment-files/{file_id}-{sanitized_filename}
//   ?op={operation_id}
//
// The file_url field in operation_attachments stores the relative path so the
// frontend can reconstruct the absolute URL.
// =============================================================================

const attachmentFiles = new Hono<{ Bindings: Env }>();

// Max payload — 25 MB. R2 itself supports much more but anything larger
// usually indicates wrong format (raw PNG of a contract instead of PDF).
const MAX_BYTES = 25 * 1024 * 1024;

// Allowed MIME types for incoming docs. PDF first because that's 90% of cases.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // doc
  'text/plain',
  'text/csv',
]);

function sanitizeFilename(name: string): string {
  // Strip path components, normalize whitespace, keep only safe chars
  const base = name.split(/[\\/]/).pop() || 'file';
  return base
    .normalize('NFKD')
    .replace(/[^\w\d.\-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

// =============================================================================
// POST /api/operations/:opId/files — upload one file for an operation
// Accepts multipart/form-data with a single field `file`.
// Returns the relative URL path which the frontend can paste into file_url.
// =============================================================================
attachmentFiles.post('/operations/:opId/files', async (c) => {
  const opId = c.req.param('opId');

  // Confirm operation exists
  const exists = await c.env.DB.prepare(
    'SELECT id FROM operations WHERE id = ? AND deleted_at IS NULL'
  ).bind(opId).first();
  if (!exists) {
    return fail(c, 404, [{ code: 'not_found', message: 'Operation not found' }]);
  }

  // Parse multipart
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return fail(c, 400, [{ code: 'invalid_form', message: 'Body must be multipart/form-data' }]);
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return fail(c, 400, [{ code: 'no_file', message: 'Form must include a "file" field' }]);
  }

  if (file.size === 0) {
    return fail(c, 400, [{ code: 'empty_file', message: 'File is empty' }]);
  }
  if (file.size > MAX_BYTES) {
    return fail(c, 422, [{
      code: 'too_large',
      message: `File exceeds ${MAX_BYTES / 1024 / 1024} MB limit (got ${(file.size / 1024 / 1024).toFixed(1)} MB)`,
    }]);
  }

  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) {
    return fail(c, 415, [{
      code: 'unsupported_mime',
      message: `File type "${mime}" not allowed. Allowed: PDF, images, Office docs, text.`,
    }]);
  }

  const fileId = `att_${crypto.randomUUID()}`;
  const safeName = sanitizeFilename(file.name);
  const r2Key = `attachments/${opId}/${fileId}-${safeName}`;

  // Stream into R2
  try {
    const buffer = await file.arrayBuffer();
    await c.env.DOCS.put(r2Key, buffer, {
      httpMetadata: {
        contentType: mime,
        contentDisposition: `attachment; filename="${safeName}"`,
      },
      customMetadata: {
        operation_id: opId,
        uploaded_at: String(Math.floor(Date.now() / 1000)),
        original_filename: file.name.slice(0, 200),
      },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_write_failed',
      message: 'Failed to store file in R2',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Return URL the frontend can paste into the attach-modal's file_url field
  const relativeUrl = `/api/attachment-files/${encodeURIComponent(r2Key)}`;

  return ok(c, {
    file_id: fileId,
    r2_key: r2Key,
    file_url: relativeUrl,
    filename: safeName,
    size: file.size,
    mime_type: mime,
  });
});

// =============================================================================
// GET /api/attachment-files/:r2Key — serve file from R2
// r2Key is URL-encoded full key (attachments/{opId}/{fileId}-{name})
// =============================================================================
attachmentFiles.get('/attachment-files/:key{.+}', async (c) => {
  const r2Key = decodeURIComponent(c.req.param('key'));

  // Path traversal safety — must start with attachments/
  if (!r2Key.startsWith('attachments/')) {
    return c.text('Not found', 404);
  }

  const obj = await c.env.DOCS.get(r2Key);
  if (!obj) {
    return c.text('File not found', 404);
  }

  const headers = new Headers();
  const mime = obj.httpMetadata?.contentType || 'application/octet-stream';
  headers.set('Content-Type', mime);
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set('etag', obj.httpEtag);
  if (obj.httpMetadata?.contentDisposition) {
    headers.set('Content-Disposition', obj.httpMetadata.contentDisposition);
  }

  return new Response(obj.body, { status: 200, headers });
});

export default attachmentFiles;
