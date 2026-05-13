// =============================================================================
// Claude Document Analyzer — for identification and classification
//
// PRINCIPLE: Claude makes ALL identification/classification decisions.
//            DeepSeek is reserved for pure arithmetic and validation.
//
// Claude receives:
//   - Full extracted text from the document
//   - Directory context from D1: companies, partners (with kinds), manufacturers, products
//   - Das Experten business rules
//
// Claude returns a strict JSON with already-resolved IDs and operation_type
// decided by business logic (not by document layout guessing).
// =============================================================================

import type { Env } from '../types';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export interface ClaudeAnalyzerInput {
  filename: string;
  document_text: string;
}

export interface ClaudeAnalysisLineItem {
  raw_description: string;
  qty: number | null;
  unit_price: number | null;
  line_amount: number | null;
  cartons: number | null;
  hs_code: string | null;
  product_id: string | null;             // resolved against products.id
  product_match_confidence: number;       // 0..1
  product_match_reason: string;
  product_alternatives: Array<{ id: string; reason: string; confidence: number }>;
}

export interface ClaudeAnalysisResult {
  document_kind: 'invoice' | 'packing_list' | 'upd' | 'contract' | 'annex' | 'specification' | 'transport_note' | 'act' | 'bank_statement' | 'other';
  doc_number: string | null;
  doc_date: string | null;                // ISO YYYY-MM-DD
  operation_date: string | null;          // ISO YYYY-MM-DD — when the goods/services were delivered
  currency: string | null;                // ISO 4217
  total_amount: number | null;

  // The TWO parties on the document
  issuer_raw: string;                     // the entity that issued the document (per document content)
  counterparty_raw: string;               // the other party

  // Claude's identification of which party is OUR side (Das Experten group)
  our_company_id: string | null;          // one of: dee, dei, dasean, dec
  our_company_confidence: number;
  our_company_reason: string;

  // Claude's identification of the counterparty
  partner_id: string | null;              // partners.id
  partner_confidence: number;
  partner_reason: string;
  partner_alternatives: Array<{ id: string; reason: string; confidence: number }>;

  // If counterparty is a manufacturer, also fill manufacturer_id
  manufacturer_id: string | null;

  // CRITICAL: operation type decided by Claude based on partner kind + business logic
  operation_type: 'purchase' | 'sale' | 'transfer' | 'service';
  operation_type_confidence: number;
  operation_type_reason: string;

  // Document direction relative to our_company (incoming = we received it; outgoing = we issued it)
  document_direction: 'incoming' | 'outgoing';

  line_items: ClaudeAnalysisLineItem[];

  // Anything Claude flagged that a human should double-check
  human_review_notes: string[];
}

interface DirectoryRow { id: string; label: string; sub?: string; kind?: string }

async function loadDirectoryContext(env: Env): Promise<{
  companies: DirectoryRow[];
  partners: DirectoryRow[];
  manufacturers: DirectoryRow[];
  products: DirectoryRow[];
}> {
  const [companies, partners, manufacturers, products] = await Promise.all([
    env.DB.prepare(`SELECT id, abbreviation, legal_name, trade_name, inn FROM companies WHERE deleted_at IS NULL`).all<any>(),
    env.DB.prepare(`SELECT id, trade_name, legal_name, kind, country, tax_id, inn FROM partners WHERE deleted_at IS NULL ORDER BY kind, trade_name`).all<any>(),
    env.DB.prepare(`SELECT id, name FROM manufacturers`).all<any>(),
    env.DB.prepare(`SELECT id, product_name, invoice_label, invoice_label_en, invoice_label_ru, invoice_label_cn, buy_price, buy_currency FROM products WHERE deleted_at IS NULL ORDER BY id`).all<any>(),
  ]);

  return {
    companies: (companies.results || []).map((x: any) => ({
      id: x.id,
      label: `${x.abbreviation} — ${x.legal_name || x.trade_name || ''}`,
      sub: x.inn ? `INN ${x.inn}` : undefined,
    })),
    partners: (partners.results || []).map((x: any) => ({
      id: x.id,
      label: `${x.trade_name}${x.legal_name && x.legal_name !== x.trade_name ? ' / ' + x.legal_name : ''}`,
      sub: [x.kind, x.country, x.tax_id || x.inn].filter(Boolean).join(' · '),
      kind: x.kind,
    })),
    manufacturers: (manufacturers.results || []).map((x: any) => ({
      id: x.id, label: x.name,
    })),
    products: (products.results || []).map((x: any) => {
      const labels = [x.product_name, x.invoice_label, x.invoice_label_en, x.invoice_label_cn].filter(Boolean);
      return {
        id: x.id,
        label: x.product_name,
        sub: [...new Set(labels.slice(1))].join(' | ') + (x.buy_price ? ` | buy ~${x.buy_price} ${x.buy_currency || ''}` : ''),
      };
    }),
  };
}

function buildSystemPrompt(): string {
  return `You are a senior business analyst at Das Experten, a multi-entity B2B group that distributes dental care products (toothpastes, toothbrushes).

YOUR JOB: Read a document (invoice, packing list, contract, statement, etc.) and return a strict JSON decision that identifies WHO is who, WHAT KIND of operation it represents, and WHAT line items it contains — using Das Experten's own directory of companies, partners, and products.

BUSINESS CONTEXT — burn this into your reasoning:

Das Experten group consists of FOUR legal entities (all referred to as "OUR side"):
  • dee     — ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ / DAS EXPERTEN EURASIA LLC (Russia, sells in CIS)
  • dei     — Das Experten International FZ-LLC (UAE, international hub)
  • dasean  — Das Experten ASEAN (Vietnam distributor)
  • dec     — Das Experten Crypto (Seychelles, IP holding)

Counterparties come in distinct KINDS (this is the most important field for classification):
  • manufacturer    — factories that produce our goods (we ALWAYS BUY from them, never sell)
  • buyer           — wholesale/retail customers (we ALWAYS SELL to them, never buy)
  • shipper / 3pl   — logistics, freight, warehousing providers (we PAY for their services)
  • service_provider — accountants, legal, marketing, banks, gov agencies (we PAY for services)

OPERATION_TYPE RULES (apply mechanically — partner.kind is ground truth, NOT document layout):
  • Counterparty is a manufacturer  → operation_type = "purchase"
  • Counterparty is a buyer         → operation_type = "sale"
  • Counterparty is a shipper, 3pl, or service_provider → operation_type = "service"
  • Both sides are Das Experten entities → operation_type = "transfer"

NEVER decide operation_type by reading "who issued the invoice". Manufacturers sometimes use templates that put the buyer's name on top — that does not change the economic reality. WE DO NOT SELL TO OUR MANUFACTURERS.

DOCUMENT_DIRECTION rule:
  • If the document was issued BY one of our companies → "outgoing"
  • If the document was issued BY the counterparty → "incoming"
  • Note: "outgoing" can coexist with operation_type "purchase" if we issued a proforma to a supplier; or with "service" if we issued a payment instruction.

LINE ITEM MATCHING:
  • Match each item against the products directory by description tokens, distinctive brand keywords (SCHWARZ, DETOX, SYMBIOS, GINGER FORCE, COCOCANNABIS, INNOWEISS, THERMO, ETALON, GROSSE, ZERO, etc.), variant tags (2in1, kids, 70ml, brush type), and price plausibility (compare unit_price to product buy_price if currency matches).
  • Distinguish 2in1 from single-pack; toothbrush variants by hardness and design.
  • If you find a STRONG single match → product_match_confidence ≥ 0.85.
  • If two products are plausible → product_match_confidence ≤ 0.6 and list alternatives.
  • If no match at all → product_id = null, product_match_confidence = 0.

OUTPUT — return ONLY valid JSON, no prose, matching this exact schema:
{
  "document_kind": "invoice" | "packing_list" | "upd" | "contract" | "annex" | "specification" | "transport_note" | "act" | "bank_statement" | "other",
  "doc_number": string | null,
  "doc_date": "YYYY-MM-DD" | null,
  "operation_date": "YYYY-MM-DD" | null,
  "currency": "RUB"|"USD"|"EUR"|"CNY"|"VND"|"AED"|"AMD" | null,
  "total_amount": number | null,

  "issuer_raw": string,
  "counterparty_raw": string,

  "our_company_id": "dee"|"dei"|"dasean"|"dec" | null,
  "our_company_confidence": 0.0-1.0,
  "our_company_reason": string,

  "partner_id": string | null,
  "partner_confidence": 0.0-1.0,
  "partner_reason": string,
  "partner_alternatives": [{"id": string, "reason": string, "confidence": 0.0-1.0}, ...],

  "manufacturer_id": string | null,

  "operation_type": "purchase"|"sale"|"transfer"|"service",
  "operation_type_confidence": 0.0-1.0,
  "operation_type_reason": string,

  "document_direction": "incoming"|"outgoing",

  "line_items": [
    {
      "raw_description": string,
      "qty": number | null,
      "unit_price": number | null,
      "line_amount": number | null,
      "cartons": number | null,
      "hs_code": string | null,
      "product_id": string | null,
      "product_match_confidence": 0.0-1.0,
      "product_match_reason": string,
      "product_alternatives": [{"id": string, "reason": string, "confidence": 0.0-1.0}, ...]
    }
  ],
  "human_review_notes": [string, ...]
}

Reasoning style: brief, factual, in English. No flowery language.`;
}

function buildUserMessage(input: ClaudeAnalyzerInput, dir: Awaited<ReturnType<typeof loadDirectoryContext>>): string {
  const formatList = (rows: DirectoryRow[]): string =>
    rows.map((r) => `  ${r.id.padEnd(28)} | ${r.label}${r.sub ? '  (' + r.sub + ')' : ''}`).join('\n');

  return `=== DIRECTORY CONTEXT (use only these IDs in your output) ===

OUR COMPANIES (Das Experten entities):
${formatList(dir.companies)}

PARTNERS (counterparties — note the kind field, it determines operation_type):
${formatList(dir.partners)}

MANUFACTURERS (subset of partners with kind='manufacturer'):
${formatList(dir.manufacturers)}

PRODUCTS (SKUs):
${formatList(dir.products)}

=== DOCUMENT TO ANALYZE ===

Filename: ${input.filename}

Contents:
${input.document_text}

=== INSTRUCTIONS ===
1. Parse all relevant fields.
2. Identify both parties; pick which one is OUR side (one of dee/dei/dasean/dec) and which is the counterparty.
3. Look up the counterparty's kind in the directory and SET operation_type accordingly. Ignore who appears "on top" of the document.
4. If the counterparty is a manufacturer, also fill manufacturer_id with the same id.
5. Match every line item to a product_id from the directory; never invent SKU strings.
6. Return ONLY the JSON object specified by the schema in the system prompt. No code fences, no commentary.`;
}

export async function analyzeDocumentWithClaude(
  env: Env,
  input: ClaudeAnalyzerInput
): Promise<ClaudeAnalysisResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured on Worker — required for document analysis');
  }

  const dir = await loadDirectoryContext(env);
  const system = buildSystemPrompt();
  const user = buildUserMessage(input, dir);

  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Claude API HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await resp.json<{ content: Array<{ type: string; text?: string }> }>();
  const textBlock = data.content?.find((b) => b.type === 'text')?.text || '';

  // Claude sometimes wraps JSON in code fences despite instructions — strip them.
  let jsonText = textBlock.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }

  try {
    return JSON.parse(jsonText) as ClaudeAnalysisResult;
  } catch (e) {
    throw new Error(`Claude returned non-JSON response: ${jsonText.slice(0, 400)}`);
  }
}
