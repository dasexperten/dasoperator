// =============================================================================
// Document Verification Pipeline — universal layer for all document parsing
// =============================================================================
//
// Mandatory flow for every parsed document (invoice/PL/bank statement/contract):
//
//   1. EXTRACT   — DeepSeek (or other parser) produces raw JSON
//   2. ENRICH    — resolve each entity reference with alternatives + confidence
//   3. VALIDATE  — deterministic checks (sums, dates, FX, schemas)
//   4. STAGE     — write to document_extractions, status='pending_review'
//   5. APPROVE   — human reviews diff-view, edits if needed, clicks Approve
//   6. COMMIT    — only on approval: write to target tables (operations, bank_tx, etc.)
//
// Reject path: status='rejected', no commit.
//
// Key invariant: DeepSeek output NEVER directly mutates business tables.
// Even high-confidence extractions go through pending_review.
// =============================================================================

import type { Env } from '../types';

// =============================================================================
// Field-level alternatives — every resolved entity ID has alternatives
// =============================================================================
export interface FieldResolution<T = string> {
  value: T | null;
  raw: string | null;              // original text from document
  confidence: number;              // 0..1
  source: 'sku_hint' | 'alias_db' | 'distinctive_keywords' | 'trigram' | 'exact_text' | 'inn_match' | 'iban_match' | 'name_fuzzy' | 'fallback' | null;
  alternatives: Array<{
    value: T;
    label: string;                 // human-readable for UI
    confidence: number;
    why: string;                   // explanation
  }>;
  needs_review: boolean;
}

export function blankResolution<T>(raw: string | null = null): FieldResolution<T> {
  return { value: null, raw, confidence: 0, source: null, alternatives: [], needs_review: true };
}

// =============================================================================
// Validation result — one check
// =============================================================================
export interface ValidationCheck {
  code: string;                    // e.g. 'sum_lines_eq_total', 'date_within_range'
  label: string;                   // human-readable
  passed: boolean;
  severity: 'info' | 'warning' | 'error';
  details?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ValidationReport {
  checks: ValidationCheck[];
  passed_count: number;
  failed_count: number;
  errors_count: number;
  warnings_count: number;
  ready_for_auto_commit: boolean;   // true only if ALL errors clear
}

export function emptyReport(): ValidationReport {
  return { checks: [], passed_count: 0, failed_count: 0, errors_count: 0, warnings_count: 0, ready_for_auto_commit: false };
}

export function addCheck(rep: ValidationReport, check: ValidationCheck): void {
  rep.checks.push(check);
  if (check.passed) rep.passed_count += 1;
  else {
    rep.failed_count += 1;
    if (check.severity === 'error') rep.errors_count += 1;
    if (check.severity === 'warning') rep.warnings_count += 1;
  }
  rep.ready_for_auto_commit = rep.errors_count === 0;
}

// =============================================================================
// Trigram similarity — fuzzy match resilient to typos / variant spellings
// =============================================================================
export function trigrams(s: string): Set<string> {
  const padded = '  ' + s.toLowerCase() + '  ';
  const set = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const tA = trigrams(a);
  const tB = trigrams(b);
  if (tA.size === 0 || tB.size === 0) return 0;
  let inter = 0;
  for (const g of tA) if (tB.has(g)) inter += 1;
  return inter / Math.max(tA.size, tB.size);
}

// =============================================================================
// Alias DB — learned mappings (from approved extractions)
// =============================================================================
export async function lookupAlias(
  env: Env,
  kind: 'product' | 'partner' | 'manufacturer' | 'company' | 'warehouse' | 'category' | 'currency',
  aliasText: string
): Promise<{ resolved_id: string; confidence: number; hit_count: number } | null> {
  const norm = (aliasText || '').toLowerCase().trim();
  if (!norm) return null;
  const row = await env.DB.prepare(
    `SELECT resolved_id, confidence, hit_count
       FROM extraction_aliases
      WHERE alias_kind = ? AND lower(alias_text) = ? AND deleted_at IS NULL
      ORDER BY hit_count DESC, confidence DESC LIMIT 1`
  ).bind(kind, norm).first<{ resolved_id: string; confidence: number; hit_count: number }>();
  return row || null;
}

export async function recordAlias(
  env: Env,
  kind: 'product' | 'partner' | 'manufacturer' | 'company' | 'warehouse' | 'category' | 'currency',
  aliasText: string,
  resolvedId: string,
  confidence: number = 1.0
): Promise<void> {
  const norm = (aliasText || '').trim();
  if (!norm) return;
  const now = Math.floor(Date.now() / 1000);
  const id = `alias_${crypto.randomUUID()}`;

  // Try update first (alias already exists?)
  const existing = await env.DB.prepare(
    `SELECT id, hit_count FROM extraction_aliases
       WHERE alias_kind = ? AND lower(alias_text) = ? AND resolved_id = ? AND deleted_at IS NULL`
  ).bind(kind, norm.toLowerCase(), resolvedId).first<{ id: string; hit_count: number }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE extraction_aliases SET hit_count = ?, last_used_at = ?, updated_at = ? WHERE id = ?`
    ).bind(existing.hit_count + 1, now, now, existing.id).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO extraction_aliases (id, alias_kind, alias_text, resolved_id, confidence, hit_count, last_used_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(id, kind, norm, resolvedId, confidence, now, now, now).run();
  }
}

// =============================================================================
// Resolve a product by description — multi-signal scoring with alternatives
// =============================================================================
const PRODUCT_STOPWORDS = new Set([
  'toothpaste', 'paste', 'паста', 'зубная', 'зубнаа', 'das', 'experten',
  'pcs', 'box', 'units', 'ctn', 'ml', 'мл', 'tube', 'tubes', 'toothbrush', 'щётка', 'brush',
  'oral', 'care', 'kids', 'kid', 'dental', 'tooth', 'teeth', 'cream', 'gel',
  '2in1', '2pcs', 'двойн', 'complex', 'for', 'and', 'the', 'with',
  'soft', 'medium', 'hard',
]);

interface ProductRow {
  id: string;
  product_name: string;
  invoice_label: string | null;
  invoice_label_en: string | null;
  invoice_label_ru: string | null;
  invoice_label_cn: string | null;
  buy_price: number | null;
  buy_currency: string | null;
}

function productHaystack(p: ProductRow): string {
  return [p.product_name, p.invoice_label, p.invoice_label_en, p.invoice_label_ru, p.invoice_label_cn]
    .filter(Boolean).join(' ').toLowerCase();
}

function distinctiveTokens(blob: string): Set<string> {
  return new Set(
    blob.replace(/[^a-z0-9а-яё ]/gi, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !PRODUCT_STOPWORDS.has(t) && !/^\d+$/.test(t))
  );
}

export async function resolveProduct(
  env: Env,
  input: {
    description: string;
    sku_hint?: string | null;
    qty?: number;
    unit_price?: number;
    currency?: string;
  }
): Promise<FieldResolution<string>> {
  const desc = (input.description || '').toLowerCase().trim();
  if (!desc) return blankResolution<string>(input.description);

  // 1. SKU hint direct match
  const hint = (input.sku_hint || '').toLowerCase().replace(/[\s\-_]/g, '');
  if (hint) {
    const direct = await env.DB.prepare(
      `SELECT id FROM products WHERE deleted_at IS NULL
         AND lower(replace(replace(replace(id,'-',''),'_',''),' ','')) = ? LIMIT 1`
    ).bind(hint).first<{ id: string }>();
    if (direct) {
      return {
        value: direct.id, raw: input.description, confidence: 0.99, source: 'sku_hint',
        alternatives: [], needs_review: false,
      };
    }
  }

  // 2. Alias DB lookup (learned from past approvals)
  const alias = await lookupAlias(env, 'product', input.description);
  if (alias && alias.hit_count >= 1) {
    return {
      value: alias.resolved_id, raw: input.description, confidence: Math.min(0.95, alias.confidence * 0.9 + 0.05 * Math.min(alias.hit_count, 10)),
      source: 'alias_db', alternatives: [], needs_review: false,
    };
  }

  // 3. Distinctive keyword + trigram scoring against ALL products
  const products = await env.DB.prepare(
    `SELECT id, product_name, invoice_label, invoice_label_en, invoice_label_ru, invoice_label_cn,
            buy_price, buy_currency
       FROM products WHERE deleted_at IS NULL`
  ).all<ProductRow>();

  const has2in1Desc = /2\s*in\s*1|2\s*pcs|2x|двойн/i.test(desc);
  const descTokens = new Set(desc.replace(/[^a-z0-9а-яё ]/gi, ' ').split(/\s+/).filter((t) => t.length >= 3));

  type Candidate = { id: string; score: number; signals: string[] };
  const scored: Candidate[] = [];

  for (const p of products.results || []) {
    const haystack = productHaystack(p);
    if (!haystack) continue;
    const distinct = distinctiveTokens(haystack);
    if (distinct.size === 0) continue;

    let score = 0;
    const signals: string[] = [];

    // (a) Distinctive token overlap (strong signal)
    let kwHits = 0;
    for (const t of distinct) {
      if (descTokens.has(t)) { kwHits += 2; }
      else if (desc.includes(t)) { kwHits += 1; }
      else if (t.length >= 6) {
        const sim = trigramSimilarity(t, desc);
        if (sim >= 0.6) kwHits += 1;
      }
    }
    if (kwHits > 0) {
      score += kwHits * 0.15;
      signals.push(`${kwHits} brand keywords`);
    }

    // (b) Trigram similarity against full product label (rescue signal)
    const tri = trigramSimilarity(haystack, desc);
    if (tri >= 0.25) {
      score += tri * 0.3;
      signals.push(`label trigram ${tri.toFixed(2)}`);
    }

    // (c) 2in1 discriminator — penalty if mismatch
    const has2in1Prod = /2in1|2pcs|двойн/i.test(haystack);
    if (has2in1Desc !== has2in1Prod) {
      score *= 0.35;
      signals.push('2in1 mismatch penalty');
    } else if (has2in1Desc && has2in1Prod) {
      signals.push('2in1 match');
    }

    // (d) Unit-price plausibility — buy_price within ±50% of extracted unit_price
    if (input.unit_price && p.buy_price && (!input.currency || !p.buy_currency || input.currency === p.buy_currency)) {
      const ratio = input.unit_price / p.buy_price;
      if (ratio >= 0.5 && ratio <= 2.0) {
        score += 0.1;
        signals.push(`price ratio ${ratio.toFixed(2)}x`);
      } else if (ratio < 0.3 || ratio > 3.0) {
        score *= 0.7;
        signals.push(`price far off (${ratio.toFixed(2)}x)`);
      }
    }

    if (score > 0) scored.push({ id: p.id, score, signals });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0 || scored[0].score < 0.15) {
    return blankResolution<string>(input.description);
  }

  const winner = scored[0];
  const runnerUp = scored[1];
  const margin = runnerUp ? winner.score - runnerUp.score : winner.score;

  // Confidence calculation: based on absolute score AND margin over runner-up
  let conf = Math.min(0.95, winner.score / 1.5);
  if (margin < 0.1) conf *= 0.8;   // ambiguity penalty
  if (winner.score >= 0.6 && margin >= 0.2) conf = Math.max(conf, 0.85);

  const productsMap: Record<string, ProductRow> = {};
  for (const p of products.results || []) productsMap[p.id] = p;
  const labelOf = (id: string) => productsMap[id]?.product_name || id;

  return {
    value: winner.id,
    raw: input.description,
    confidence: conf,
    source: 'distinctive_keywords',
    alternatives: scored.slice(1, 4).map((c) => ({
      value: c.id,
      label: labelOf(c.id),
      confidence: Math.min(0.9, c.score / 1.5),
      why: c.signals.join(', '),
    })),
    needs_review: conf < 0.80 || margin < 0.15,
  };
}

// =============================================================================
// Validate line items against header total
// =============================================================================
export function validateLineItemsSum(
  lineItems: Array<{ line_amount?: number; qty?: number; unit_price?: number }>,
  headerTotal: number | null,
  toleranceRel: number = 0.005
): ValidationCheck {
  const computed = lineItems.reduce((sum, li) => {
    const amt = (typeof li.line_amount === 'number' && li.line_amount > 0)
      ? li.line_amount
      : (li.qty || 0) * (li.unit_price || 0);
    return sum + amt;
  }, 0);

  if (headerTotal == null) {
    return {
      code: 'sum_lines_no_total', label: 'Header total missing',
      passed: false, severity: 'warning',
      details: `Sum of lines = ${computed.toFixed(2)}, no header total to compare`,
      actual: computed, expected: null,
    };
  }

  const diff = Math.abs(computed - headerTotal);
  const rel = headerTotal > 0 ? diff / headerTotal : 0;
  const passed = rel <= toleranceRel;

  return {
    code: 'sum_lines_eq_total',
    label: passed ? 'Line sum matches header total' : 'Line sum mismatch',
    passed,
    severity: passed ? 'info' : 'error',
    details: passed
      ? `${computed.toFixed(2)} ≈ ${headerTotal.toFixed(2)}`
      : `Sum ${computed.toFixed(2)} vs declared ${headerTotal.toFixed(2)} (diff ${diff.toFixed(2)} = ${(rel * 100).toFixed(2)}%)`,
    expected: headerTotal,
    actual: computed,
  };
}

export function validateEachLineMath(
  lineItems: Array<{ qty?: number; unit_price?: number; line_amount?: number; description?: string }>,
  toleranceRel: number = 0.01
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  lineItems.forEach((li, i) => {
    if (typeof li.qty !== 'number' || typeof li.unit_price !== 'number' || typeof li.line_amount !== 'number') return;
    const computed = li.qty * li.unit_price;
    const diff = Math.abs(computed - li.line_amount);
    const rel = li.line_amount > 0 ? diff / li.line_amount : 0;
    const passed = rel <= toleranceRel;
    checks.push({
      code: `line_math_${i + 1}`,
      label: `Line ${i + 1}: qty × price = amount`,
      passed,
      severity: passed ? 'info' : 'error',
      details: passed
        ? `${li.qty} × ${li.unit_price} = ${computed.toFixed(2)} ≈ ${li.line_amount.toFixed(2)}`
        : `${li.qty} × ${li.unit_price} = ${computed.toFixed(2)} ≠ ${li.line_amount.toFixed(2)} (line ${i + 1}: ${(li.description || '').slice(0, 40)})`,
      expected: computed,
      actual: li.line_amount,
    });
  });
  return checks;
}

export function validateDateInRange(
  docDate: string | null,
  minYear: number = 2020,
  maxYearAhead: number = 1
): ValidationCheck {
  if (!docDate) {
    return { code: 'date_missing', label: 'Date missing', passed: false, severity: 'warning' };
  }
  const d = new Date(docDate);
  if (isNaN(d.getTime())) {
    return { code: 'date_invalid', label: 'Date unparseable', passed: false, severity: 'error', actual: docDate };
  }
  const y = d.getFullYear();
  const now = new Date();
  const maxYear = now.getFullYear() + maxYearAhead;
  const passed = y >= minYear && y <= maxYear;
  return {
    code: 'date_in_range', label: 'Date plausibility',
    passed, severity: passed ? 'info' : 'error',
    details: passed ? `${docDate} ∈ [${minYear}, ${maxYear}]` : `Year ${y} outside [${minYear}, ${maxYear}]`,
    actual: docDate,
  };
}

export function validateCurrency(currency: string | null): ValidationCheck {
  const ALLOWED = ['RUB', 'USD', 'EUR', 'CNY', 'VND', 'AED', 'AMD'];
  if (!currency) return { code: 'currency_missing', label: 'Currency missing', passed: false, severity: 'error' };
  const passed = ALLOWED.includes(currency.toUpperCase());
  return {
    code: 'currency_known', label: 'Currency in allowed list',
    passed, severity: passed ? 'info' : 'error',
    actual: currency, expected: ALLOWED.join('|'),
  };
}

// =============================================================================
// Resolve partner / manufacturer / company — by INN/IBAN first, then name
// =============================================================================
export async function resolvePartner(
  env: Env,
  input: { name: string | null; inn?: string | null; iban?: string | null; expected_kind?: string | null }
): Promise<FieldResolution<string>> {
  if (input.inn) {
    const byInn = await env.DB.prepare(
      `SELECT id, trade_name FROM partners WHERE (tax_id = ? OR inn = ?) AND deleted_at IS NULL LIMIT 1`
    ).bind(input.inn, input.inn).first<{ id: string; trade_name: string }>();
    if (byInn) {
      return { value: byInn.id, raw: input.name, confidence: 0.98, source: 'inn_match', alternatives: [], needs_review: false };
    }
  }
  if (input.iban) {
    const byIban = await env.DB.prepare(
      `SELECT id, trade_name FROM partners WHERE replace(iban,' ','') = replace(?,' ','') AND deleted_at IS NULL LIMIT 1`
    ).bind(input.iban).first<{ id: string; trade_name: string }>();
    if (byIban) {
      return { value: byIban.id, raw: input.name, confidence: 0.97, source: 'iban_match', alternatives: [], needs_review: false };
    }
  }

  if (input.name) {
    const alias = await lookupAlias(env, 'partner', input.name);
    if (alias) return { value: alias.resolved_id, raw: input.name, confidence: 0.92, source: 'alias_db', alternatives: [], needs_review: false };

    const rows = await env.DB.prepare(
      `SELECT id, trade_name FROM partners WHERE deleted_at IS NULL`
    ).all<{ id: string; trade_name: string }>();

    const scored = (rows.results || []).map((p) => ({
      id: p.id, name: p.trade_name, sim: trigramSimilarity(p.trade_name, input.name!),
    })).filter((x) => x.sim >= 0.3).sort((a, b) => b.sim - a.sim);

    if (scored.length === 0) return blankResolution<string>(input.name);
    const winner = scored[0];
    const margin = scored[1] ? winner.sim - scored[1].sim : winner.sim;
    return {
      value: winner.id, raw: input.name,
      confidence: Math.min(0.85, winner.sim) * (margin < 0.1 ? 0.8 : 1),
      source: 'name_fuzzy',
      alternatives: scored.slice(1, 4).map((s) => ({
        value: s.id, label: s.name, confidence: s.sim, why: `name similarity ${s.sim.toFixed(2)}`,
      })),
      needs_review: winner.sim < 0.7 || margin < 0.15,
    };
  }

  return blankResolution<string>(input.name);
}

export async function resolveCompany(
  env: Env,
  input: { name: string | null; inn?: string | null }
): Promise<FieldResolution<string>> {
  if (input.inn) {
    const byInn = await env.DB.prepare(
      `SELECT id, abbreviation FROM companies WHERE inn = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(input.inn).first<{ id: string; abbreviation: string }>();
    if (byInn) return { value: byInn.id, raw: input.name, confidence: 0.99, source: 'inn_match', alternatives: [], needs_review: false };
  }
  if (input.name) {
    const alias = await lookupAlias(env, 'company', input.name);
    if (alias) return { value: alias.resolved_id, raw: input.name, confidence: 0.93, source: 'alias_db', alternatives: [], needs_review: false };

    const rows = await env.DB.prepare(
      `SELECT id, abbreviation, legal_name, trade_name FROM companies WHERE deleted_at IS NULL`
    ).all<{ id: string; abbreviation: string; legal_name: string | null; trade_name: string | null }>();

    const scored = (rows.results || []).flatMap((c) => {
      const names = [c.abbreviation, c.legal_name, c.trade_name].filter(Boolean) as string[];
      return names.map((n) => ({ id: c.id, name: n, sim: trigramSimilarity(n, input.name!) }));
    }).filter((x) => x.sim >= 0.3).sort((a, b) => b.sim - a.sim);

    if (scored.length === 0) return blankResolution<string>(input.name);
    const winner = scored[0];
    const margin = scored[1] ? winner.sim - scored[1].sim : winner.sim;
    return {
      value: winner.id, raw: input.name,
      confidence: Math.min(0.9, winner.sim) * (margin < 0.1 ? 0.8 : 1),
      source: 'name_fuzzy',
      alternatives: scored.slice(1, 4).map((s) => ({ value: s.id, label: s.name, confidence: s.sim, why: `name similarity ${s.sim.toFixed(2)}` })),
      needs_review: winner.sim < 0.7,
    };
  }
  return blankResolution<string>(input.name);
}

// =============================================================================
// Stage an extraction into document_extractions
// =============================================================================
export interface StageExtractionInput {
  source: 'upload' | 'bank_statement' | 'email_attachment' | 'contract_upload' | 'invoicer_validation';
  document_kind: 'invoice' | 'packing_list' | 'upd' | 'contract' | 'annex' | 'specification' | 'transport_note' | 'act' | 'bank_statement' | 'bank_tx' | 'other';
  r2_key?: string | null;
  filename?: string | null;
  file_mime?: string | null;
  raw_text?: string | null;
  raw_extract: Record<string, unknown>;
  header_fields: Record<string, FieldResolution<any>>;
  line_items?: Array<Record<string, unknown>>;
  validation: ValidationReport;
  target_table: string;
  target_action: 'create' | 'update' | 'attach';
}

export async function stageExtraction(env: Env, input: StageExtractionInput): Promise<string> {
  const id = `xtr_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  // Overall confidence: lowest confidence of any header field that has a value,
  // multiplied by validation health (errors → 0, warnings → 0.7, clean → 1.0)
  let overallConf = 1.0;
  for (const [_k, fr] of Object.entries(input.header_fields)) {
    if (fr.value != null && fr.confidence < overallConf) overallConf = fr.confidence;
  }
  if (input.validation.errors_count > 0) overallConf = 0;
  else if (input.validation.warnings_count > 0) overallConf *= 0.7;

  await env.DB.prepare(
    `INSERT INTO document_extractions
       (id, source, document_kind, r2_key, filename, file_mime,
        raw_text, raw_extract_json, header_fields_json, line_items_json,
        validation_results_json, overall_confidence, status,
        target_table, target_action,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?)`
  ).bind(
    id, input.source, input.document_kind,
    input.r2_key ?? null, input.filename ?? null, input.file_mime ?? null,
    input.raw_text ? input.raw_text.slice(0, 100_000) : null,
    JSON.stringify(input.raw_extract),
    JSON.stringify(input.header_fields),
    input.line_items ? JSON.stringify(input.line_items) : null,
    JSON.stringify(input.validation),
    overallConf,
    input.target_table, input.target_action,
    now, now
  ).run();

  return id;
}
