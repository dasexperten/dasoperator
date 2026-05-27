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
import { callAnthropicRaw } from './anthropic';

// Model — Sonnet 4.6 (dateless pinned snapshot, released 2026-02-17).
const ANALYZER_MODEL = 'claude-sonnet-4-6';

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

  // Contract reference extracted from document — used to link to existing contract record
  contract_no: string | null;             // e.g. "080824", "MF01-DEA/YZ", "06062022"
  contract_confidence: number;
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
    env.DB.prepare(`SELECT id, abbreviation, legal_name, trade_name, tax_id FROM companies WHERE deleted_at IS NULL`).all<any>(),
    env.DB.prepare(`SELECT id, trade_name, legal_name, kind, country, tax_id FROM partners WHERE deleted_at IS NULL ORDER BY kind, trade_name`).all<any>(),
    env.DB.prepare(`SELECT id, name FROM manufacturers`).all<any>(),
    env.DB.prepare(`SELECT id, product_name, invoice_label, invoice_label_en, invoice_label_ru, invoice_label_cn, buy_price, buy_currency FROM products WHERE deleted_at IS NULL ORDER BY id`).all<any>(),
  ]);

  return {
    companies: (companies.results || []).map((x: any) => ({
      id: x.id,
      label: `${x.abbreviation} — ${x.legal_name || x.trade_name || ''}`,
      sub: x.tax_id ? `TIN ${x.tax_id}` : undefined,
    })),
    partners: (partners.results || []).map((x: any) => ({
      id: x.id,
      label: `${x.trade_name}${x.legal_name && x.legal_name !== x.trade_name ? ' / ' + x.legal_name : ''}`,
      sub: [x.kind, x.country, x.tax_id].filter(Boolean).join(' · '),
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

LINE ITEM MATCHING — CRITICAL RULES:

PRODUCT IDs IN OUR DIRECTORY:
  • Base SKU (e.g. de203, de117)            — represents a SINGLE physical unit (one tube of toothpaste, one toothbrush)
  • Bundle variant '*aa' (e.g. de203aa)      — represents the 2-pack pre-bundled packaging
  • Bundle variant '*aaaa' (e.g. de117aaaa)  — represents the 4-pack pre-bundled packaging (toothbrushes only)

THE MATCHING RULE (apply mechanically):

  For INVOICE / PURCHASE / SHIPMENT LINE ITEMS — always match to the BASE SKU (single unit).
  The quantity on a manufacturer invoice always counts SINGLES, even when the description mentions:
       "2in1", "2pcs", "2 PACK", "pre-bundled", "pre-packed", "2x", "doubled-up", "shrink-wrapped pair", etc.
  These phrases describe packaging form, NOT a different product. They do NOT mean you should match the '*aa' SKU.

  Example — invoice line:
       "Das Experten GINGER FORCE 2IN1 70ml — qty 14400"
       Correct match:   product_id = de203, qty = 14400  ← BASE SKU
       Wrong match:     product_id = de203aa, qty = 14400 ← variants are warehouse-stock-units, not invoice-units

  Match to the '*aa' or '*aaaa' variant ONLY in these specific contexts (rare):
       • Inventory adjustment documents that explicitly count bundles
       • Stock transfer/recount sheets that list bundles as the unit
       • Customer-facing PL where buyer ordered bundles as separate SKUs
  When in doubt, default to the BASE SKU.

  Standalone blister-pack products (e.g. de121 "DOPPEL AKTION 1+1 Brush", de125/de126 "Interdental 4 pc")
  have no base/variant duality — they are their own SKU. Match directly to them.

MATCHING SIGNALS (in order of strength):
  1. Distinctive brand keyword (SCHWARZ, DETOX, SYMBIOS, GINGER FORCE, COCOCANNABIS, INNOWEISS, THERMO,
     ETALON, GROSSE, ZERO, KINDER, BUDDY, EVOLUTION, etc.)
  2. Product type (toothpaste vs toothbrush vs floss vs mouthwash vs tongue cleaner vs interdental)
  3. Volume/size (70ml, 50ml, 100m floss length)
  4. Bristle hardness for brushes (soft, medium, hard) — distinguishes SENSITIV/MITTEL/KRAFT
  5. Unit price plausibility — compare unit_price to product buy_price if currencies match

CONFIDENCE SCORING:
  • Single distinctive keyword + matching size → product_match_confidence ≥ 0.90
  • Multiple plausible products → product_match_confidence ≤ 0.6, list alternatives
  • No match → product_id = null, product_match_confidence = 0

CONTRACT NUMBER EXTRACTION:
  Look in the document for the contract this transaction references. Common labels:
    Contract / Договор / Контракт / 合同号 / 合同
    Agreement / Соглашение
    "по контракту", "согласно договору", "based on contract", "ref. contract"
  Some invoices use "Счёт №" or "Invoice №" — that's the DOCUMENT number, NOT the contract.
  If the document is itself a contract (document_kind='contract'), the contract_no is the document's own number.
  When found, return the raw contract number string EXACTLY as printed (preserve slashes, dashes, spaces).
  If not found anywhere → contract_no = null, contract_confidence = 0.

OUTPUT — return ONLY valid JSON, no prose, matching this exact schema:
{
  "document_kind": "invoice" | "packing_list" | "upd" | "contract" | "annex" | "specification" | "transport_note" | "act" | "bank_statement" | "other",
  "doc_number": string | null,
  "doc_date": "YYYY-MM-DD" | null,
  "operation_date": "YYYY-MM-DD" | null,
  "contract_no": string | null,
  "contract_confidence": 0.0-1.0,
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
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error('Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY configured — required for document analysis');
  }

  const dir = await loadDirectoryContext(env);
  const system = buildSystemPrompt();
  const user = buildUserMessage(input, dir);

  // Prefer OAuth (subscription quota). callAnthropicRaw handles the identity
  // preamble + required headers internally; falls back to pay-as-you-go API
  // key path only if OAuth token is missing.
  const data = await callAnthropicRaw({
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '',
    model: ANALYZER_MODEL,
    maxTokens: 4096,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const textBlock = data.content?.find((b: any) => b.type === 'text')?.text || '';

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
