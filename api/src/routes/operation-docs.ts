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
import { callPro } from '../lib/llm';

const operationDocs = new Hono<{ Bindings: Env }>();


const DOC_EXTRACTION_PROMPT = `You are a document classifier and table extractor for Das Experten ERP.
Documents reference operations by ID: DEE-N / DEI-N / DEASEAN-N / DEC-N (e.g. DEE-007, DEI-012).

Read the document and output ONLY valid JSON:
{
  "operation_reference": string | null,    // e.g. "DEE-007", null if not found
  "doc_type": "invoice" | "packing_list" | "upd" | "contract" | "annex" | "specification" | "transport_note" | "act" | "other",
  "doc_number": string | null,
  "doc_date": "YYYY-MM-DD" | null,
  "currency": "RUB" | "USD" | "EUR" | "CNY" | "VND" | "AED" | "AMD" | null,
  "amount": number | null,                 // grand total
  "issuer": string | null,                 // name of the company that issued the document
  "counterparty": string | null,           // the other side
  "direction": "outgoing" | "incoming",    // outgoing = Das Experten issued it, incoming = we received it
  "confidence": 0.0-1.0,                   // how sure about the operation_reference
  "notes": string,                         // any other detail worth keeping
  "line_items": [                          // ARRAY of goods/services in the document; [] if none
    {
      "description": string,               // raw row text from the document
      "sku_hint": string | null,           // any SKU code visible in the row (e.g. "DE201", "de-205aa") — null if not present
      "qty": number,                       // quantity of pieces/units
      "unit_price": number,                // price per piece in the document currency
      "line_amount": number,               // qty * unit_price, as printed in the document
      "hs_code": string | null,            // HS Code if visible (e.g. "3306100000")
      "cartons": number | null             // number of cartons / packages if separately stated
    }
  ]
}

For line_items, extract EVERY row from the goods table. Be exact with descriptions — preserve product names like "GINGER FORCE 2IN1 70ML", "SYMBIOS 70ML", "SCHWARZ Toothpaste", "AKTIV forte" — these are matched against SKU master.

operation_reference must match exactly DEE-\\d+ / DEI-\\d+ / DEASEAN-\\d+ / DEC-\\d+. If multiple candidates appear, pick the one most central to the document (in header or main reference field, not random mention).
Set operation_reference to null if you don't see a clear match.`;

interface ExtractedLineItem {
  description: string;
  sku_hint: string | null;
  qty: number;
  unit_price: number;
  line_amount: number;
  hs_code: string | null;
  cartons: number | null;
}

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
  line_items: ExtractedLineItem[];
}

interface PrefillData {
  // Pre-resolved IDs (best fuzzy match against DB) — may be null if no good match
  partner_id: string | null;
  partner_name: string | null;
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
// Resolve extracted line items → DB product_id by SKU code or fuzzy name match
// Strategy:
//   1. If sku_hint matches a product id directly → return
//   2. Find distinctive brand keyword (SYMBIOS, DETOX, GINGER, COCANNABIS, etc.)
//      that appears in BOTH description and a product label → that product wins
//   3. Token-overlap fallback as last resort
// 2in1 / single-pack discriminator applied as final filter
// =============================================================================
async function resolveLineItemSku(
  env: Env,
  item: ExtractedLineItem
): Promise<string | null> {
  // 1. SKU hint direct match
  const hint = (item.sku_hint || '').toLowerCase().replace(/[\s\-_]/g, '');
  if (hint) {
    const direct = await env.DB.prepare(
      `SELECT id FROM products WHERE deleted_at IS NULL AND lower(replace(replace(replace(id,'-',''),'_',''),' ','')) = ? LIMIT 1`
    ).bind(hint).first<{ id: string }>();
    if (direct) return direct.id;
  }

  const desc = (item.description || '').toLowerCase();
  if (!desc) return null;

  const rows = await env.DB.prepare(
    `SELECT id, product_name, invoice_label, invoice_label_en, invoice_label_ru, invoice_label_cn
       FROM products WHERE deleted_at IS NULL`
  ).all<{ id: string; product_name: string; invoice_label: string | null; invoice_label_en: string | null; invoice_label_ru: string | null; invoice_label_cn: string | null }>();

  // Discriminator: 2in1 in description requires 2in1 in product (and vice versa)
  const has2in1Desc = /2\s*in\s*1|2\s*pcs|2x|двойн/i.test(desc);

  // 2. Distinctive keyword scoring — brand names usually carry product identity
  // Build for each product a set of "distinctive tokens" — words that appear only in this product
  // and not in most others. Practical heuristic: keep any word from product_name/invoice_label
  // that is alpha-only and >= 4 chars (excluding generic words like "toothpaste", "паста").
  const STOPWORDS = new Set([
    'toothpaste','paste','паста','зубная','зубнаа','das','experten','daselzasten',
    'pcs','box','units','ctn','ml','шт','мл','tube','tubes','toothbrush','щётка','brush',
    'oral','care','kids','kid','dental','tooth','teeth','tube','cream','gel','gum','gums',
    '2in1','2pcs','двойн','complex','for','and','the','with','soft','medium','hard','vapor',
  ]);

  const distinctiveByProduct = new Map<string, Set<string>>();
  for (const p of rows.results || []) {
    const blob = [p.product_name, p.invoice_label, p.invoice_label_en, p.invoice_label_ru, p.invoice_label_cn]
      .filter(Boolean).join(' ').toLowerCase();
    const tokens = new Set(
      blob.replace(/[^a-z0-9а-яё ]/gi, ' ').split(/\s+/)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    );
    distinctiveByProduct.set(p.id, tokens);
  }

  // For each product, count distinctive tokens that ALSO appear in description
  const descTokens = new Set(
    desc.replace(/[^a-z0-9а-яё ]/gi, ' ').split(/\s+/).filter((t) => t.length >= 4)
  );

  let bestId: string | null = null;
  let bestKwScore = 0;

  for (const p of rows.results || []) {
    const distinct = distinctiveByProduct.get(p.id);
    if (!distinct || distinct.size === 0) continue;

    let hits = 0;
    for (const t of distinct) {
      // Exact token match OR substring match
      if (descTokens.has(t)) { hits += 2; continue; }
      if (desc.includes(t)) { hits += 1; continue; }
      // Trigram-overlap fuzzy (handles COCANNABIS vs COCOCANNABIS / typos)
      if (t.length >= 6) {
        const trigrams = (str: string): Set<string> => {
          const s = ' ' + str + ' ';
          const out = new Set<string>();
          for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
          return out;
        };
        const tg1 = trigrams(t);
        const tg2 = trigrams(desc);
        let inter = 0;
        for (const g of tg1) if (tg2.has(g)) inter += 1;
        const sim = inter / tg1.size;  // jaccard-like ratio
        if (sim >= 0.6) hits += 1;
      }
    }

    if (hits === 0) continue;

    // Filter 2in1 mismatch
    const haystack = [p.product_name, p.invoice_label, p.invoice_label_en, p.invoice_label_ru, p.invoice_label_cn]
      .filter(Boolean).join(' ').toLowerCase();
    const has2in1Prod = /2in1|2pcs|двойн/i.test(haystack);
    if (has2in1Desc !== has2in1Prod) {
      hits = Math.floor(hits * 0.4);
      if (hits === 0) continue;
    }

    if (hits > bestKwScore) {
      bestKwScore = hits;
      bestId = p.id;
    }
  }

  // 3. Only return if we found at least one strong distinctive token match
  if (bestId && bestKwScore >= 2) return bestId;

  return null;
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
    `SELECT id, trade_name as name FROM partners WHERE deleted_at IS NULL`
  ).all<{ id: string; name: string }>();
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

  return {
    partner_id: bestPartner?.id ?? null,
    partner_name: bestPartner?.name ?? otherSideRaw ?? null,
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
// =============================================================================
// POST /upload-to-pipeline — STRICT mode: parse + STAGE to verification pipeline
// =============================================================================
// Same parsing as /upload-document, but instead of auto-attach or stub-create,
// the result is STAGED in document_extractions for human review.
// Critical for official documents (invoices, PLs, UPDs) — no direct writes.
//
// Returns: { extraction_id, header_fields, line_items, validation, overall_confidence }
// UI: route operator to /inbox/documents/:extraction_id to review.
// =============================================================================
operationDocs.post('/upload-to-pipeline', async (c) => {
  // STRICT MODE — Claude performs ALL identification & classification.
  // DeepSeek is NOT invoked. Validation arithmetic happens in the pipeline core.
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return fail(c, 422, [{ code: 'no_file', message: 'No file uploaded' }]);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = file.name;
  const mimeType = file.type;
  const safeName = sanitizeFilename(filename);
  const fileId = crypto.randomUUID();

  // Save original to R2
  const r2Key = `operation-docs/${new Date().toISOString().slice(0, 10)}/${fileId}__${safeName}`;
  await c.env.DOCS.put(r2Key, bytes, {
    httpMetadata: { contentType: mimeType || 'application/octet-stream' },
  });

  // Extract text (deterministic code path — pdf-parse / docx-parse etc., no LLM)
  let text: string;
  try {
    text = await extractTextFromFile(bytes, mimeType, filename);
  } catch (e) {
    return fail(c, 500, [{ code: 'extract_failed', message: e instanceof Error ? e.message : String(e) }]);
  }
  if (!text || text.length < 5) {
    return fail(c, 422, [{ code: 'unreadable', message: 'Could not read text from file' }]);
  }

  if (!c.env.CLAUDE_CODE_OAUTH_TOKEN && !c.env.DEEPSEEK_API_KEY) {
    return fail(c, 500, [{ code: 'no_llm', message: 'No LLM provider configured (need CLAUDE_CODE_OAUTH_TOKEN or DEEPSEEK_API_KEY)' }]);
  }

  // Claude analyzes the document with full Das Experten directory context.
  // Returns already-resolved IDs and operation_type decided by business logic.
  const { analyzeDocumentWithClaude } = await import('../lib/claude-analyzer');
  const trimmed = text.length > 80_000 ? text.slice(0, 80_000) : text;

  let analysis;
  try {
    analysis = await analyzeDocumentWithClaude(c.env, {
      filename,
      document_text: trimmed,
    });
  } catch (e) {
    return fail(c, 500, [{ code: 'claude_failed', message: e instanceof Error ? e.message : String(e) }]);
  }

  // Verify Claude's identified IDs actually exist in DB (sanity check before staging)
  const idChecks: Array<{ name: string; sql: string; value: string }> = [];
  if (analysis.our_company_id) idChecks.push({ name: 'our_company_id', sql: 'SELECT 1 FROM companies WHERE id = ? AND deleted_at IS NULL', value: analysis.our_company_id });
  if (analysis.partner_id) idChecks.push({ name: 'partner_id', sql: 'SELECT 1 FROM partners WHERE id = ? AND deleted_at IS NULL', value: analysis.partner_id });
  if (analysis.manufacturer_id) idChecks.push({ name: 'manufacturer_id', sql: 'SELECT 1 FROM manufacturers WHERE id = ?', value: analysis.manufacturer_id });
  for (const li of analysis.line_items || []) {
    if (li.product_id) idChecks.push({ name: `product:${li.product_id}`, sql: 'SELECT 1 FROM products WHERE id = ? AND deleted_at IS NULL', value: li.product_id });
  }
  const invalidIds: string[] = [];
  for (const chk of idChecks) {
    const found = await c.env.DB.prepare(chk.sql).bind(chk.value).first();
    if (!found) invalidIds.push(`${chk.name}=${chk.value}`);
  }
  // Don't reject — just record as a review note so the operator sees what to fix.
  if (invalidIds.length > 0) {
    analysis.human_review_notes = analysis.human_review_notes || [];
    analysis.human_review_notes.push(`Claude returned IDs not present in DB: ${invalidIds.join(', ')}`);
  }

  // Stage in pending_review with Claude's decisions as the resolved values.
  const {
    emptyReport, addCheck,
    validateLineItemsSum, validateEachLineMath, validateDateInRange, validateCurrency,
    stageExtraction,
  } = await import('../lib/verification-pipeline');

  // Which raw name corresponds to which side depends on document direction:
  //   outgoing — WE issued the doc → issuer = us, counterparty = partner
  //   incoming — partner issued the doc → issuer = partner, counterparty = us
  const ourSideRaw = analysis.document_direction === 'outgoing' ? analysis.issuer_raw : analysis.counterparty_raw;
  const partnerSideRaw = analysis.document_direction === 'outgoing' ? analysis.counterparty_raw : analysis.issuer_raw;

  // Resolve contract_id from contract_no (look up matching contract record)
  let resolvedContractId: string | null = null;
  let contractMatchConfidence = 0;
  let contractMatchReason = '';
  if (analysis.contract_no && analysis.our_company_id && analysis.partner_id) {
    // Exact match by contract_no + parties (case-insensitive, ignoring spaces/dashes)
    const normalize = (s: string) => s.replace(/[\s\-_/]/g, '').toLowerCase();
    const cnNorm = normalize(analysis.contract_no);
    const contracts = await c.env.DB.prepare(
      `SELECT id, contract_no FROM contracts
       WHERE our_company_id = ? AND partner_id = ? AND deleted_at IS NULL`
    ).bind(analysis.our_company_id, analysis.partner_id).all<{ id: string; contract_no: string }>();
    for (const row of contracts.results) {
      if (normalize(row.contract_no) === cnNorm) {
        resolvedContractId = row.id;
        contractMatchConfidence = 0.95;
        contractMatchReason = `Exact match on contract_no=${row.contract_no}`;
        break;
      }
    }
    // Fallback: prefix match (handles "080824" matching "080824/A1" parent)
    if (!resolvedContractId) {
      for (const row of contracts.results) {
        if (normalize(row.contract_no).startsWith(cnNorm) || cnNorm.startsWith(normalize(row.contract_no))) {
          resolvedContractId = row.id;
          contractMatchConfidence = 0.7;
          contractMatchReason = `Prefix match on contract_no=${row.contract_no}`;
          break;
        }
      }
    }
    if (!resolvedContractId) {
      contractMatchReason = `No contract found with no=${analysis.contract_no} for (${analysis.our_company_id}, ${analysis.partner_id})`;
    }
  }

  const headerFields: Record<string, any> = {
    operation_type: {
      value: analysis.operation_type,
      raw: analysis.operation_type_reason,
      confidence: analysis.operation_type_confidence,
      source: 'claude',
      alternatives: [],
      needs_review: analysis.operation_type_confidence < 0.85,
    },
    our_company_id: {
      value: analysis.our_company_id,
      raw: ourSideRaw,
      confidence: analysis.our_company_confidence,
      source: 'claude',
      alternatives: [],
      needs_review: analysis.our_company_confidence < 0.85 || !analysis.our_company_id,
    },
    partner_id: {
      value: analysis.partner_id,
      raw: partnerSideRaw,
      confidence: analysis.partner_confidence,
      source: 'claude',
      alternatives: (analysis.partner_alternatives || []).map((a) => ({
        value: a.id, label: a.id, confidence: a.confidence, why: a.reason,
      })),
      needs_review: analysis.partner_confidence < 0.85 || !analysis.partner_id,
    },
    manufacturer_id: {
      value: analysis.manufacturer_id,
      raw: partnerSideRaw,
      confidence: analysis.manufacturer_id ? 0.95 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: false,
    },
    contract_id: {
      value: resolvedContractId,
      raw: analysis.contract_no,
      confidence: contractMatchConfidence,
      source: 'claude',
      alternatives: [],
      needs_review: !!analysis.contract_no && !resolvedContractId,
      note: contractMatchReason || undefined,
    },
    currency: {
      value: analysis.currency,
      raw: analysis.currency,
      confidence: analysis.currency ? 0.95 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: !analysis.currency,
    },
    total_amount: {
      value: analysis.total_amount,
      raw: String(analysis.total_amount),
      confidence: analysis.total_amount ? 0.95 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: !analysis.total_amount,
    },
    operation_date: {
      value: analysis.operation_date ? Math.floor(new Date(analysis.operation_date + 'T12:00:00Z').getTime() / 1000) : null,
      raw: analysis.operation_date,
      confidence: analysis.operation_date ? 0.9 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: !analysis.operation_date,
    },
    doc_number: {
      value: analysis.doc_number,
      raw: analysis.doc_number,
      confidence: analysis.doc_number ? 0.95 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: !analysis.doc_number,
    },
    doc_date: {
      value: analysis.doc_date,
      raw: analysis.doc_date,
      confidence: analysis.doc_date ? 0.9 : 0,
      source: 'claude',
      alternatives: [],
      needs_review: !analysis.doc_date,
    },
    issuer: {
      value: analysis.issuer_raw,
      raw: analysis.issuer_raw,
      confidence: 0.95,
      source: 'claude',
      alternatives: [],
      needs_review: false,
    },
    direction: {
      value: analysis.document_direction,
      raw: analysis.document_direction,
      confidence: 0.9,
      source: 'claude',
      alternatives: [],
      needs_review: false,
    },
  };

  const resolvedItems = (analysis.line_items || []).map((li) => ({
    description: li.raw_description,
    sku_hint: null,
    qty: li.qty,
    unit_price: li.unit_price,
    line_amount: li.line_amount,
    hs_code: li.hs_code,
    cartons: li.cartons,
    product_id: li.product_id,
    product_id_source: 'claude',
    product_id_confidence: li.product_match_confidence,
    product_id_alternatives: (li.product_alternatives || []).map((a) => ({
      value: a.id, label: a.id, confidence: a.confidence, why: a.reason,
    })),
    needs_review: li.product_match_confidence < 0.85 || !li.product_id,
  }));

  // Validation arithmetic — pure deterministic code, no LLM
  const report = emptyReport();
  addCheck(report, validateLineItemsSum(resolvedItems, analysis.total_amount));
  for (const ch of validateEachLineMath(resolvedItems)) addCheck(report, ch);
  addCheck(report, validateDateInRange(analysis.doc_date));
  addCheck(report, validateCurrency(analysis.currency));
  const unmatched = resolvedItems.filter((r) => !r.product_id).length;
  addCheck(report, {
    code: 'all_lines_matched',
    label: 'All line items matched to SKUs',
    passed: unmatched === 0,
    severity: unmatched === 0 ? 'info' : (unmatched <= resolvedItems.length / 2 ? 'warning' : 'error'),
    details: unmatched === 0 ? `${resolvedItems.length}/${resolvedItems.length}` : `${unmatched}/${resolvedItems.length} unmatched`,
  });
  const flagged = resolvedItems.filter((r) => r.needs_review).length;
  if (flagged > 0) {
    addCheck(report, {
      code: 'lines_low_confidence',
      label: 'Lines flagged for review',
      passed: false,
      severity: 'warning',
      details: `${flagged} line(s) below confidence threshold`,
    });
  }
  // Claude's review notes are EXPLANATORY (e.g. "matched 2IN1 to base SKU per rule"),
  // they are info-level transparency, not warnings. Surface them as passed info checks
  // so they don't drag down the overall confidence score.
  for (const note of analysis.human_review_notes || []) {
    addCheck(report, {
      code: 'claude_note',
      label: 'Claude review note',
      passed: true,
      severity: 'info',
      details: note,
    });
  }

  const extractionId = await stageExtraction(c.env, {
    source: 'upload',
    document_kind: analysis.document_kind || 'other',
    r2_key: r2Key,
    filename, file_mime: mimeType, raw_text: text,
    raw_extract: analysis as any,
    header_fields: headerFields,
    line_items: resolvedItems,
    validation: report,
    target_table: 'operations',
    target_action: 'create',
  });

  // AUTO-COMMIT: if Claude is fully confident on every critical field AND validation is clean,
  // skip the verification queue and commit the operation directly.
  const claudeFullyConfident =
    analysis.operation_type_confidence >= 0.95 &&
    analysis.our_company_confidence >= 0.95 &&
    analysis.partner_confidence >= 0.95 &&
    (analysis.line_items || []).every((li) => li.product_match_confidence >= 0.90 && li.product_id) &&
    analysis.our_company_id && analysis.partner_id;

  const validationClean =
    report.errors_count === 0 &&
    report.checks.filter((c) => !c.passed && c.severity === 'warning').length === 0;

  const idsAllValid = invalidIds.length === 0;

  if (claudeFullyConfident && validationClean && idsAllValid) {
    // Auto-approve via the same code path the review UI uses
    try {
      const approveResp = await c.env.SELF.fetch(
        `https://internal/api/document-extractions/${extractionId}/approve`,
        { method: 'POST' }
      );
      const approveData = await approveResp.json<any>();
      if (approveData.success) {
        return ok(c, {
          extraction_id: extractionId,
          mode: 'auto_committed',
          target_id: approveData.result.target_id,
          reference: approveData.result.reference,
          claude_analysis: analysis,
        }, [`Operation ${approveData.result.reference} created automatically (Claude was fully confident).`]);
      }
      // If approve failed for some reason, fall through to staged_for_review behaviour
    } catch (e) {
      // Fall through — leave it in queue rather than blocking the upload
    }
  }

  return ok(c, {
    extraction_id: extractionId,
    mode: 'staged_for_review',
    header_fields: headerFields,
    line_items: resolvedItems,
    validation: report,
    claude_analysis: analysis,
    r2_key: r2Key,
    filename,
  }, [`Document staged for review (id: ${extractionId}). Open Inbox → Documents to verify and approve.`]);
});

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

    let dsContent: string;
    try {
      const res = await callPro(
        [
          { role: 'system', content: DOC_EXTRACTION_PROMPT },
          { role: 'user', content: `Filename: ${filename}\n\nContents:\n${trimmed}` },
        ],
        { env: c.env, temperature: 0 },
      );
      dsContent = res.text || '{}';
    } catch (e) {
      return fail(c, 500, [
        { code: 'llm_error', message: e instanceof Error ? e.message : 'LLM call failed' },
      ]);
    }
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

  if (body.partner_id) {
    const p = await c.env.DB.prepare('SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL').bind(body.partner_id).first();
    if (!p) return fail(c, 404, [{ code: 'partner_not_found', message: `partner_id ${body.partner_id} does not exist` }]);
  }
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
  const refResult = await issueOperationReference(c.env.DB, {
    operationType: body.operation_type,
    ourCompanyId: body.our_company_id,
    manufacturerId: body.manufacturer_id || null,
    partnerId: body.partner_id || null,
    operationDateUnix: body.operation_date,
  });
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
    'manual',
    `Document used to create this stub operation: ${body.filename}`.slice(0, 500),
    now,
    now,
  );

  // Resolve line items if the upload payload included them (extracted by DeepSeek)
  const incomingLineItems: any[] = Array.isArray(body.line_items) ? body.line_items : [];
  const lineItemStmts: any[] = [];
  const lineItemsReport: { matched: number; unmatched: number; total: number } = {
    matched: 0, unmatched: 0, total: incomingLineItems.length,
  };

  for (const li of incomingLineItems) {
    const productId = await resolveLineItemSku(c.env, li);
    if (!productId) {
      lineItemsReport.unmatched += 1;
      continue;  // skip line items that don't match any SKU
    }
    lineItemsReport.matched += 1;

    const qty = Number(li.qty) || 0;
    const unitPrice = Number(li.unit_price) || 0;
    const lineAmount = (typeof li.line_amount === 'number' && li.line_amount > 0)
      ? Number(li.line_amount)
      : qty * unitPrice;
    const cartons = li.cartons ? Number(li.cartons) : 0;
    const liId = `li_${crypto.randomUUID()}`;
    lineItemStmts.push(
      c.env.DB.prepare(
        `INSERT INTO line_items
           (id, operation_id, product_id, item_description, qty, cartons, inner_boxes,
            unit_price, discount_pct, unit_price_after_disc, line_amount,
            currency, line_usd_equiv, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, NULL, ?, ?)`
      ).bind(
        liId, operationId, productId,
        (li.description || '').slice(0, 500),
        qty, cartons,
        unitPrice, unitPrice, lineAmount,
        body.currency, now, now
      )
    );
  }

  try {
    await c.env.DB.batch([insertOpStmt, insertAttachStmt, ...lineItemStmts]);
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to create stub operation',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Auto-allocate any awaiting bank_tx that match this new operation
  try {
    const { allocateAwaitingTxToOperation } = await import('../lib/bank-tx-allocator');
    await allocateAwaitingTxToOperation(c.env, operationId);
  } catch (e) {
    console.error('[operation-docs] allocator failed (non-fatal):', e);
  }

  // Compose warnings based on what landed
  const warnings: string[] = [];
  if (lineItemsReport.total === 0) {
    warnings.push('No line items found in the document — operation has no positions');
  } else if (lineItemsReport.unmatched > 0) {
    warnings.push(`${lineItemsReport.unmatched} of ${lineItemsReport.total} line items could not be matched to existing SKUs and were skipped`);
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
      stub: lineItemsReport.matched === 0,
    },
    attachment: {
      id: attachId,
      file_url: attachUrl,
      filename: body.filename,
    },
    line_items_report: lineItemsReport,
    warnings,
  }, [`Operation ${refResult.reference} created with ${lineItemsReport.matched} matched line items`]);
});

export default operationDocs;
