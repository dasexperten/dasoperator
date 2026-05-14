// =============================================================================
// /api/operation-documents — upload + classify operation documents
//
// Manual upload entry point. File is stored in R2, then a document_extraction
// row is created with status='pending_review' and target_table='operations'
// (default) so that the existing approve/triage flow picks it up.
//
// Phase 1 (this commit): store + pending. Classifier wiring lives in Phase 2.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const operationDocuments = new Hono<{ Bindings: Env }>();

// =============================================================================
// POST /api/operation-documents/upload
//   multipart/form-data:
//     file=<binary>
//     company_id?=dee|dei|dasean|dec   — receiving entity (buyer side)
//     source_id?=ods_...                — optional originating source row
//   Returns: { extraction_id, r2_key, filename, status }
// =============================================================================
operationDocuments.post('/upload', async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file') as File | null;
    const companyId = (form.get('company_id') as string | null) ?? null;
    const sourceId = (form.get('source_id') as string | null) ?? null;

    if (!file) {
      return fail(c, 422, [{ code: 'no_file', message: 'No file uploaded (form field "file")' }]);
    }

    // Validate company_id if present
    if (companyId && !['dee', 'dei', 'dasean', 'dec'].includes(companyId)) {
      return fail(c, 422, [{ code: 'bad_company', message: `Invalid company_id: ${companyId}` }]);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = file.name;
    const mimeType = file.type || 'application/octet-stream';

    // Store original in R2 for audit/replay
    const r2Key = `operation-documents/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}__${filename}`;
    try {
      await c.env.DOCS.put(r2Key, bytes, {
        httpMetadata: { contentType: mimeType },
      });
    } catch (e) {
      console.error('[operation-documents] R2 upload failed:', e);
      return fail(c, 500, [{ code: 'r2_failed', message: 'Could not store file' }]);
    }

    // Create document_extractions row in 'pending_review' state.
    // Classifier (Phase 2) will fill document_kind, header_fields_json, target_table/action.
    // For now we mark document_kind='other' and target_table='operations' as a default.
    const extractionId = `dex_${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    const initialNotes = sourceId
      ? JSON.stringify({ origin: 'manual_upload', source_id: sourceId, hint_company_id: companyId })
      : JSON.stringify({ origin: 'manual_upload', hint_company_id: companyId });

    await c.env.DB.prepare(
      `INSERT INTO document_extractions
         (id, source, document_kind, r2_key, filename, file_mime,
          raw_extract_json, overall_confidence, status,
          target_table, target_action,
          created_at, updated_at)
       VALUES (?, 'upload', 'other', ?, ?, ?,
               ?, 0, 'pending_review',
               'operations', 'create',
               ?, ?)`
    ).bind(
      extractionId, r2Key, filename, mimeType,
      initialNotes,
      now, now
    ).run();

    return ok(c, {
      extraction_id: extractionId,
      r2_key: r2Key,
      filename,
      mime_type: mimeType,
      status: 'pending_review',
      message: 'File uploaded. Awaiting classification and review.',
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default operationDocuments;
