// =============================================================================
// /api/bank-statements — upload + parse + insert flow
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';
import {
  parseStatement,
  insertTransactions,
  extractTextFromFile,
} from '../lib/bank-statement-parser';

const bankStatements = new Hono<{ Bindings: Env }>();

// =============================================================================
// POST /api/bank-statements/upload
//   multipart/form-data: file=<binary>, company_id?=dee|dei|dasean|dec
//   Returns: { parsed: {...}, summary: {inserted, skipped, errors} }
// =============================================================================
bankStatements.post('/upload', async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file') as File | null;
    const companyId = form.get('company_id') as string | null;

    if (!file) {
      return fail(c, 422, [{ code: 'no_file', message: 'No file uploaded (form field "file")' }]);
    }

    // Read bytes
    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = file.name;
    const mimeType = file.type;

    // Store original in R2 for audit/replay
    const r2Key = `bank-statements/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}__${filename}`;
    try {
      await c.env.DOCS.put(r2Key, bytes, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' },
      });
    } catch (e) {
      console.error('[bank-statements] R2 upload failed:', e);
    }

    // Extract text
    const text = await extractTextFromFile(bytes, mimeType, filename);
    if (text.length < 50) {
      return fail(c, 422, [
        {
          code: 'unreadable_file',
          message: 'Could not extract readable text from file. For PDF: try CSV/XLSX export from your bank. For XLSX: save as CSV.',
          details: { filename, mime_type: mimeType, extracted_length: text.length },
        },
      ]);
    }

    // Parse with DeepSeek
    const parsed = await parseStatement(c.env, text, filename);

    // Insert into bank_transactions
    const summary = await insertTransactions(c.env, parsed, {
      company_id: companyId ?? undefined,
    });

    return ok(c, {
      filename,
      r2_key: r2Key,
      account_number: parsed.account_number,
      period_from: parsed.period_from,
      period_to: parsed.period_to,
      summary,
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/bank-statements/run-ingestion
//   Manual trigger for the email-watch cron (same code path).
// =============================================================================
bankStatements.post('/run-ingestion', async (c) => {
  try {
    const { runBankStatementIngestion } = await import('../lib/bank-statement-ingestion');
    const stats = await runBankStatementIngestion(c.env);
    return ok(c, stats);
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default bankStatements;
