// =============================================================================
// /api/operations/upload-document — drop a document, auto-link to operation
// =============================================================================
//
// Flow:
//   1. Save file to R2 (operation-docs/YYYY-MM-DD/{uuid}__{filename})
//   2. Extract text from file
//   3. Send to DeepSeek with extraction prompt
//   4. Match reference (DEE-007 / DEI-012 / DEASEAN-003 / DEC-001) to operations
//   5. Auto-link via operation_attachments OR return suggestion list
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import { extractTextFromFile } from '../lib/bank-statement-parser';

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

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  return base.normalize('NFKD').replace(/[^\w\d.\-]/g, '_').replace(/_+/g, '_').slice(0, 120);
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
    const fileUrl = `/api/attachment-files/${fileId}-${safeName}`;
    // Note: attachment-files route currently expects path /operations/{opId}/file_id-name
    // For unbound files we use R2 key directly via DOCS binding from another endpoint.

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
      // Save inside the R2 path that attachment-files route can read back later
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
        message: 'Could not read text from file. Please pick an operation manually.',
      });
    }

    // 4. Classify with DeepSeek
    if (!c.env.DEEPSEEK_API_KEY) {
      return ok(c, {
        mode: 'no_llm',
        r2_key: r2Key,
        filename,
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

    // 7. Low confidence or no match → return candidates for manual pick
    // Build candidate list: top 20 most recent operations + any with matching ref
    const candidates = await c.env.DB.prepare(
      `SELECT o.id, o.reference, o.status, o.operation_date, o.total_amount, o.currency,
              p.trade_name AS partner_name
         FROM operations o
         LEFT JOIN partners p ON p.id = o.partner_id
        WHERE o.deleted_at IS NULL
        ORDER BY o.operation_date DESC
        LIMIT 30`
    ).all();

    return ok(c, {
      mode: matchedOp ? 'low_confidence' : 'no_match',
      r2_key: r2Key,
      filename,
      file_size: bytes.length,
      file_mime: mimeType,
      extracted,
      suggestion: matchedOp,
      candidates: candidates.results ?? [],
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default operationDocs;
