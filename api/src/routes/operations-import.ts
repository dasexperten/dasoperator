// =============================================================================
// Operations import — parse an arbitrary Excel/CSV via DeepSeek and return
// a list of { sku, qty } that the frontend can drop straight into entries.
//
// The AI receives:
//   - Plain-text representation of all non-empty rows from the uploaded file
//   - Our 33 SKUs with product_name + invoice_label + category
// And is told to return ONLY a JSON array of {sku, qty} entries, mapping
// recognized rows to canonical SKU IDs. Unrecognized rows go into a
// separate `unmatched` array so the user sees what couldn't be matched.
// =============================================================================

import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const operationsImport = new Hono<{ Bindings: Env }>();

interface ParsedLine {
  sku: string;       // canonical lowercase SKU id ("de201")
  qty: number;       // integer pieces, > 0
  source_row: string; // original row text for user reference
}

interface UnmatchedRow {
  text: string;      // original row text
  reason: string;    // why AI couldn't match it
}

interface DeepSeekResponse {
  matched: Array<{ sku: string; qty: number; source_row: string }>;
  unmatched: Array<{ text: string; reason: string }>;
}

operationsImport.post('/parse-excel', async (c) => {
  // Read multipart/form-data
  let file: File | null = null;
  try {
    const form = await c.req.formData();
    const f = form.get('file');
    // In Workers runtime, File is a global. Duck-type check works for both.
    if (f && typeof f === 'object' && 'arrayBuffer' in f && 'size' in f) {
      file = f as File;
    }
  } catch {
    return fail(c, 400, [{ code: 'invalid_form', message: 'Expected multipart/form-data with a file field' }]);
  }
  if (!file) {
    return fail(c, 400, [{ code: 'no_file', message: 'No file uploaded' }]);
  }
  if (file.size > 10 * 1024 * 1024) {
    return fail(c, 400, [{ code: 'file_too_big', message: 'File must be 10 MB or smaller' }]);
  }

  // Parse to plain text rows
  let rowsText: string[];
  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      return fail(c, 400, [{ code: 'empty_workbook', message: 'Excel file has no sheets' }]);
    }
    const sheet = wb.Sheets[sheetName]!;
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(sheet, { header: 1, defval: '', blankrows: false });
    rowsText = rows
      .map((r) => Array.isArray(r) ? r.map((cell) => String(cell ?? '').trim()).filter(Boolean).join(' | ') : '')
      .filter((s) => s.length > 0);
  } catch (e) {
    return fail(c, 400, [{ code: 'parse_failed', message: `Could not parse file: ${e instanceof Error ? e.message : 'unknown error'}` }]);
  }

  if (rowsText.length === 0) {
    return fail(c, 400, [{ code: 'empty_file', message: 'File has no readable rows' }]);
  }

  // Load product reference for the AI
  const productsRes = await c.env.DB.prepare(`
    SELECT id, product_name, invoice_label, category
    FROM products
    WHERE deleted_at IS NULL
    ORDER BY id
  `).all<{ id: string; product_name: string; invoice_label: string; category: string }>();

  const productLines = productsRes.results
    .map((p) => `${p.id.toUpperCase()} | ${p.product_name} | ${p.invoice_label} | ${p.category}`)
    .join('\n');

  // Build the DeepSeek prompt
  const systemPrompt = `You are a parser that maps rows from an arbitrary purchase order or invoice spreadsheet to a fixed catalog of SKUs.

CATALOG (one SKU per line: ID | product_name | invoice_label | category):
${productLines}

RULES:
1. Read the user's spreadsheet rows carefully — they may be in any language (Russian, English, Chinese), have typos, abbreviations, or alternate brand names.
2. For each row that clearly refers to a catalog SKU, return it under "matched" with the canonical SKU id (lowercase, like "de201") and a positive integer qty.
3. If a row mentions a quantity in cartons or boxes, do NOT multiply — just return the qty exactly as stated, prefer pieces if both are mentioned.
4. If a row could match multiple SKUs or you're not confident, put it under "unmatched" with a short reason.
5. Skip header rows, totals, blank rows, comments — they go neither in matched nor unmatched.
6. Return ONLY a JSON object, nothing else.

OUTPUT SHAPE:
{
  "matched": [{"sku": "de201", "qty": 1440, "source_row": "<original row text>"}],
  "unmatched": [{"text": "<original row text>", "reason": "<why>"}]
}`;

  const userPrompt = `Spreadsheet rows:\n\n${rowsText.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nReturn ONLY the JSON object.`;

  // Call DeepSeek
  let aiText: string;
  try {
    const dsRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${c.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 4000,
      }),
    });
    if (!dsRes.ok) {
      const errBody = await dsRes.text();
      return fail(c, 500, [{ code: 'ai_failed', message: `AI provider returned ${dsRes.status}: ${errBody.slice(0, 200)}` }]);
    }
    const dsJson = await dsRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    aiText = dsJson.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    return fail(c, 500, [{ code: 'ai_network', message: `Could not reach AI: ${e instanceof Error ? e.message : 'unknown'}` }]);
  }

  // Parse JSON, with one retry strategy if AI wrapped it in prose
  let parsed: DeepSeekResponse;
  try {
    parsed = JSON.parse(aiText) as DeepSeekResponse;
  } catch {
    // Strip ```json fences and any leading prose
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fail(c, 500, [{ code: 'ai_invalid_json', message: 'AI did not return valid JSON', details: { raw: aiText.slice(0, 500) } }]);
    }
    try {
      parsed = JSON.parse(jsonMatch[0]) as DeepSeekResponse;
    } catch {
      return fail(c, 500, [{ code: 'ai_invalid_json', message: 'AI returned malformed JSON', details: { raw: aiText.slice(0, 500) } }]);
    }
  }

  // Validate + normalize
  const matched: ParsedLine[] = [];
  const unmatched: UnmatchedRow[] = [];
  const validSkus = new Set(productsRes.results.map((p) => p.id));

  if (Array.isArray(parsed.matched)) {
    for (const m of parsed.matched) {
      const sku = String(m.sku ?? '').toLowerCase();
      const qty = Math.floor(Number(m.qty ?? 0));
      if (!validSkus.has(sku)) {
        unmatched.push({ text: String(m.source_row ?? sku), reason: `Unknown SKU "${sku}"` });
        continue;
      }
      if (qty <= 0) {
        unmatched.push({ text: String(m.source_row ?? sku), reason: 'Quantity must be positive' });
        continue;
      }
      matched.push({ sku, qty, source_row: String(m.source_row ?? '') });
    }
  }
  if (Array.isArray(parsed.unmatched)) {
    for (const u of parsed.unmatched) {
      unmatched.push({ text: String(u.text ?? ''), reason: String(u.reason ?? 'Could not match') });
    }
  }

  return ok(c, {
    matched,
    unmatched,
    rows_processed: rowsText.length,
  });
});

export default operationsImport;
