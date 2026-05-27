// =============================================================================
// Bank transaction → Operation auto-matcher  (v2 — cascade with service path)
// =============================================================================
// Decision cascade:
//   STEP 1  partner lookup by INN
//     ├─ found     → STEP 2
//     └─ not found → STEP 1b: try to classify by payment_purpose
//          ├─ keyword match → auto-create draft service-provider partner
//          │                  + close operation immediately
//          │                  + mark match_method='partner_auto_created'
//          └─ no clue       → orphan PMT attachment + 'partner_not_found'
//                             (Inbox asks: "Who? Which category?")
//
//   STEP 2  partner known, branch by direction × kind:
//     OUT + service kind  → close immediately, match_method='auto_service_closed'
//     OUT + goods kind    → match candidate operations or create draft
//     IN                  → match candidate sales operations or create draft
//
//   Result persisted into:
//     bank_transactions.matched_payment_id  (now holds operation_id)
//     bank_transactions.match_method        (outcome enum below)
//     bank_transactions.matched_at
//
// Webhook never sees an exception; failures surface via match_method only.
// =============================================================================

import type { Env } from '../types';
import { findExistingPartnerByName, isBankProviderName, generateReadablePartnerId } from './partner-dedup';
import { recordRuleHit, findOperationForRule } from './bank-match-rules';
import { classifyTransaction, decideAction, persistSuggestion } from './transaction-classifier';
import { reconcileBankTxAmountIntoInbox } from './invoice-amount-reconcile';

// Currency minor-unit conversion factor — how many minor units per 1 major.
// RUB (Modulbank), USD/EUR/AED (Wio): stored × 100 — divide.
// CNY (VTB MT103, MT202): stored as full juans, no subdivision — divide by 1.
// VND, JPY, KRW: no subdivision in stored format — divide by 1.
// Used everywhere we convert bank_transactions.amount → decimal major units.
function getMinorFactor(currency: string): number {
  const c = (currency || '').toUpperCase();
  if (c === 'CNY' || c === 'VND' || c === 'JPY' || c === 'KRW') return 1;
  return 100; // RUB, USD, EUR, AED, default
}

function toMajor(amount: number, currency: string): number {
  return amount / getMinorFactor(currency);
}

const DATE_WINDOW_DAYS = 30;
const FX_TOLERANCE_PCT = 0.01;

// Lowercase, ё→е normalised stems. Any hit → service.
const SERVICE_KEYWORDS = [
  // rent / occupancy
  'аренд', 'наем', 'найм',
  // storage / 3PL
  'хранен', 'склад', 'ответствен', 'фулфилм', 'фулфилл', 'fulfilment', 'fulfillment',
  // assembly / packing / kitting
  'сборк', 'сборщ', 'упаковк', 'комплектац', 'формирован',
  // shipping / delivery / transport
  'доставк', 'перевозк', 'транспортн', 'логистич', 'фрахт', 'экспедир', 'отправк', 'shipping',
  // generic services / fees
  'услуг', 'обслуживан', 'сервис', 'service',
  // commissions / agency
  'комисси', 'вознагражден', 'агентск', 'роялти',
  // subscriptions / SaaS / access
  'подписк', 'доступ', 'тариф', 'license', 'лиценз', 'subscription',
  // marketing / advertising
  'реклам', 'продвижен', 'маркетинг', 'промо',
  // accounting / legal / consulting
  'бухгалтер', 'юридич', 'консультац', 'аудит',
  // telco / utility / IT
  'связ', 'телефон', 'интернет', 'хостинг', 'домен', 'банковск',
  // marketplaces / acquiring
  'маркетплейс', 'эквайринг', 'процессинг',
];

const SERVICE_KINDS = new Set(['service_provider', '3pl', 'shipper']);

const RU_MONTHS: Record<string, number> = {
  'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
  'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12,
};

export type MatchOutcome =
  | 'auto_matched'
  | 'auto_service_closed'
  | 'auto_created_draft'
  | 'partner_auto_created'
  | 'ambiguous'
  | 'partner_not_found'
  | 'no_candidate' | 'rule_matched' | 'rule_matched_no_op'
  | 'bank_self_reference_skipped'
  | 'awaiting_marketplace_settlement'
  | 'awaiting_invoice';

export interface AutoMatchResult {
  outcome: MatchOutcome;
  operation_id: string | null;
  attachment_ids: string[];
  candidate_ids?: string[];
  reason?: string;
  partner_id?: string | null;
}

// ---- public helpers (exported for inbox UI + tests) ------------------------

function normalise(s: string): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export function looksLikeService(purpose: string): boolean {
  const n = normalise(purpose);
  return SERVICE_KEYWORDS.some((kw) => n.includes(kw));
}

export function extractServiceDescription(purpose: string): string {
  if (!purpose) return '';
  // Strip "Оплата по счёту № X от DD месяц YYYY г." prefix.
  let s = purpose.replace(
    /^.*?сч[её]т[у-яё]*\s*[№#]?\s*[A-Za-z0-9А-Яа-я\-\/_.]+\s*от\s*\d{1,2}[\s.\-\/]+[\s\S]*?(?:\d{4})\s*(?:г\.?)?[\s.,;:]*/i,
    '',
  ).trim();
  // Strip "В т.ч. НДС 22% - 835,28" tail.
  s = s.replace(/\bВ\s*т\.?ч\.?\s*НДС[\s\S]+$/i, '').trim();
  return s || purpose.trim();
}

export function parseInvoiceFromPurpose(purpose: string): {
  doc_number: string;
  doc_date: number | null;
} | null {
  if (!purpose) return null;

  const re1 = /сч[её]т[у-яё]*\s*[№#]?\s*([A-Za-z0-9А-Яа-я\-\/_.]+)\s*от\s*(\d{1,2})\s*([а-яё]+)\s*(\d{4})/i;
  const m1 = purpose.match(re1);
  if (m1 && m1[1] && m1[2] && m1[3] && m1[4]) {
    const day = parseInt(m1[2], 10);
    const month = RU_MONTHS[m1[3].toLowerCase()];
    const year = parseInt(m1[4], 10);
    if (month) {
      const date = Math.floor(Date.UTC(year, month - 1, day) / 1000);
      return { doc_number: m1[1].trim(), doc_date: date };
    }
  }

  const re2 = /сч[её]т[у-яё]*\s*[№#]?\s*([A-Za-z0-9А-Яа-я\-\/_.]+)\s*от\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/i;
  const m2 = purpose.match(re2);
  if (m2 && m2[1] && m2[2] && m2[3] && m2[4]) {
    const day = parseInt(m2[2], 10);
    const month = parseInt(m2[3], 10);
    let year = parseInt(m2[4], 10);
    if (year < 100) year += 2000;
    const date = Math.floor(Date.UTC(year, month - 1, day) / 1000);
    return { doc_number: m2[1].trim(), doc_date: date };
  }

  // 'invoice' must be a full word; 'inv.' (with dot) is the short form.
  // Plain 'inv' alone is too risky — matched 'INVOICE' as 'INV' then consumed 'OICE'.
  const re3 = /\b(?:invoice|inv\.)\s*[№#:]?\s*([A-Za-z0-9][A-Za-z0-9\-\/_.]*)/i;
  const m3 = purpose.match(re3);
  if (m3 && m3[1]) {
    return { doc_number: m3[1].trim(), doc_date: null };
  }

  return null;
}

// ---- main entry -----------------------------------------------------------

export async function autoMatchBankTransaction(
  env: Env,
  txId: string,
): Promise<AutoMatchResult> {
  const tx = await env.DB.prepare(`
    SELECT id, direction, amount, currency, executed_at,
           contragent_inn, contragent_name, payment_purpose,
           external_doc_number
    FROM bank_transactions
    WHERE id = ?
  `).bind(txId).first<{
    id: string;
    direction: string;
    amount: number;
    currency: string;
    executed_at: number;
    contragent_inn: string;
    contragent_name: string;
    payment_purpose: string;
    external_doc_number: string;
  }>();

  if (!tx) {
    return { outcome: 'no_candidate', operation_id: null, attachment_ids: [], reason: 'tx not found' };
  }

  // RAIL 2 (2026-05-27): bank tx amount is the source of truth for invoice
  // reconciliation. If this tx's purpose names an invoice that already has
  // an inbox row with a different extracted_amount (vision LLM mis-read),
  // overwrite the inbox amount before matching proceeds. Side-effect only —
  // never fails the matcher.
  try {
    const reconciled = await reconcileBankTxAmountIntoInbox(env, txId);
    if (reconciled.length > 0) {
      console.log(`[bank-auto-match] rail2 reconciled ${reconciled.length} inbox row(s) for tx ${txId}`);
    }
  } catch (reconcileErr) {
    console.error('[bank-auto-match] rail2 reconcile failed (non-fatal):', reconcileErr);
  }

  // =========================================================================
  // IDEMPOTENCY GUARD — bank_tx already matched to an ACTIVE operation? skip.
  // Without this, repeated invocations on the same tx (cron sweeps, manual
  // retries, webhook retries) create duplicate service operations every run.
  // =========================================================================
  const alreadyMatched = await env.DB.prepare(`
    SELECT bt.matched_operation_id, bt.match_method, o.reference
      FROM bank_transactions bt
      JOIN operations o ON o.id = bt.matched_operation_id
     WHERE bt.id = ?
       AND bt.matched_operation_id IS NOT NULL
       AND o.deleted_at IS NULL
     LIMIT 1
  `).bind(txId).first<{ matched_operation_id: string; match_method: string | null; reference: string }>();

  if (alreadyMatched?.matched_operation_id) {
    return {
      outcome: (alreadyMatched.match_method as MatchOutcome) || 'auto_matched',
      operation_id: alreadyMatched.matched_operation_id,
      attachment_ids: [],
      reason: `already matched to ${alreadyMatched.reference} via ${alreadyMatched.match_method ?? 'unknown'} — idempotent skip`,
    };
  }

  // =========================================================================
  // =========================================================================
  // CLASSIFIER CASCADE — L1 rules + L2 counterparty memory (pure SQL, no LLM)
  // =========================================================================
  try {
    const classifierTx = {
      contragent_inn: tx.contragent_inn,
      contragent_account: (tx as any).contragent_account ?? null,
      contragent_name: tx.contragent_name,
      payment_purpose: tx.payment_purpose,
      direction: tx.direction as 'incoming' | 'outgoing',
    };
    const cls = await classifyTransaction(env, classifierTx);
    const decision = decideAction(cls);

    // Persist suggestion regardless of action (helps Inbox UI show 'suggested category')
    if (decision.category_id) {
      await persistSuggestion(env, txId, decision);
    }

    // AUTO classify: rule sure enough AND not always_confirm category
    if (decision.action === 'auto_classify' && decision.partner_id) {
      const targetOp = await findOperationForRule(env, {
        id: decision.matched_rule_id ?? '',
        partner_id: decision.partner_id,
        contragent_inn: tx.contragent_inn || null,
        purpose_pattern: null,
        direction: 'any',
        default_operation_type: decision.default_operation_type ?? 'purchase',
        default_our_company_id: null,
        hit_count: 0, last_hit_at: null,
        created_at: 0, updated_at: 0, deleted_at: null, notes: null,
      } as any, {
        amount: tx.amount, currency: tx.currency, executed_at: tx.executed_at,
      });

      if (targetOp) {
        const attIds = await attachPaymentAndInvoice(env, {
          operation_id: targetOp.operation_id, tx,
        });
        await persistOutcome(env, txId, 'rule_matched' as MatchOutcome, targetOp.operation_id);
        if (decision.matched_rule_id) await recordRuleHit(env, decision.matched_rule_id);
        return {
          outcome: 'rule_matched' as MatchOutcome,
          operation_id: targetOp.operation_id,
          partner_id: decision.partner_id,
          attachment_ids: attIds,
          reason: `Auto-classified: ${decision.reason} → ${targetOp.reference}`,
        };
      }

      // No open op found — DO NOT auto-create. Operations are created from
      // invoices/acts (via inbox-ingestion), never from bank tx. Park as
      // awaiting_invoice; allocate to the inbox-derived op when it arrives.
      if (decision.default_operation_type === 'purchase' && decision.partner_id) {
        await persistOutcome(env, txId, 'awaiting_invoice', null);
        if (decision.matched_rule_id) await recordRuleHit(env, decision.matched_rule_id);
        return {
          outcome: 'awaiting_invoice',
          operation_id: null,
          partner_id: decision.partner_id,
          attachment_ids: [],
          reason: `Auto-classified (${decision.reason}) — awaiting invoice/act for allocation`,
        };
      }
    }

    // For 'inbox_suggest' or 'inbox_blank' actions: fall through to old cascade
    // (which will leave the tx in Inbox; UI reads suggested_category_id from DB).
  } catch (e) {
    console.error('[bank-auto-match] classifier failed, falling through:', e);
  }

  // Pre-compute shared values used across STEP 1b/2 branches.
  // bank_transactions.amount is stored in MINOR UNITS (kopeks for RUB,
  // cents for USD/EUR/CNY). Divide by 100 to get decimal major units.
  // Previous '2026-05-16' note claiming amount is already decimal was WRONG —
  // caused mass-inflated AUTO-DRAFT operations (49M RUB Ozon sales etc).
  const txMajor = toMajor(tx.amount, tx.currency);
  const isService = looksLikeService(tx.payment_purpose);

  // STEP 1
  let partner = await findPartnerByInn(env, tx.contragent_inn);

  // STEP 1a — INN miss: try fuzzy trade_name match (foreign counterparties,
  // missing INN in bank statement, etc.). Prevents duplicate prt_draft_* rows
  // for the same real-world company on consecutive transactions.
  if (!partner && tx.contragent_name) {
    partner = await findExistingPartnerByName(env.DB, tx.contragent_name);
    if (partner) {
      console.log('[bank-auto-match] matched by trade_name fallback:',
        tx.contragent_name, '→', partner.id);
    }
  }

  // STEP 1a2 — narration contract lookup. SWIFT MT103 payments routed through
  // correspondent banks (VTB → Honghui etc.) hide the real partner inside
  // payment_purpose as "CONTRACT NNNNNN". Resolve via contracts table.
  // MUST run before bank-self-reference filter, otherwise these payments get
  // silently discarded as "bank fees".
  if (!partner && tx.payment_purpose) {
    partner = await findPartnerByContractInNarration(env, tx.payment_purpose);
    if (partner) {
      console.log('[bank-auto-match] matched by contract narration:',
        '→', partner.id);
    }
  }

  // STEP 1b — partner not found
  if (!partner) {
    // STEP 1b-pre — bank self-reference filter. If the bank webhook landed
    // its own name in contragent_name (commission charge, internal transfer,
    // bank fee, etc.), do NOT create a partner row. Banks belong in
    // bank_providers, not partners.
    if (tx.contragent_name && await isBankProviderName(env.DB, tx.contragent_name)) {
      console.log('[bank-auto-match] skipping bank self-reference:', tx.contragent_name);
      await persistOutcome(env, txId, 'bank_self_reference_skipped', null);
      return {
        outcome: 'bank_self_reference_skipped' as MatchOutcome,
        operation_id: null,
        attachment_ids: [],
      };
    }

    if (isService && tx.direction === 'outgoing' && tx.contragent_name) {
      // Create draft partner record (we need an entity to reconcile against)
      // but DO NOT auto-create an operation. Operations come from invoices/acts.
      const newPartnerId = await createDraftPartner(env, {
        trade_name: tx.contragent_name,
        legal_name: tx.contragent_name,
        tax_id: tx.contragent_inn || '',
        currency: tx.currency,
        kind: 'service_provider',
      });
      await persistOutcome(env, txId, 'awaiting_invoice', null);
      return {
        outcome: 'awaiting_invoice',
        operation_id: null,
        partner_id: newPartnerId,
        attachment_ids: [],
        reason: 'partner draft created from tx.contragent_name; awaiting invoice/act for allocation',
      };
    }

    const orphanId = await createOrphanAttachment(env, {
      tx,
      notes: `partner_not_found: INN=${tx.contragent_inn || 'none'}, name=${tx.contragent_name}`,
    });
    await persistOutcome(env, txId, 'partner_not_found', null);
    return {
      outcome: 'partner_not_found',
      operation_id: null,
      partner_id: null,
      attachment_ids: [orphanId],
      reason: 'no partner by INN; no service keywords for auto-create',
    };
  }

  // STEP 2 — partner known
  if (tx.direction === 'outgoing' && SERVICE_KINDS.has(partner.kind || '')) {
    const parsedInv350 = parseInvoiceFromPurpose(tx.payment_purpose || '');

    // SEARCH-BEFORE-CREATE: look for existing active service/tax op with same
    // (partner, amount, currency, calendar date). Without this, every bank
    // statement re-import produces a fresh duplicate operation.
    const dayStart = Math.floor(tx.executed_at / 86400) * 86400;
    const dayEnd   = dayStart + 86400;
    const existingServiceOp = await env.DB.prepare(`
      SELECT id, reference
        FROM operations
       WHERE partner_id = ?
         AND operation_type IN ('service','tax','purchase')
         AND currency = ?
         AND total_amount = ?
         AND operation_date >= ?
         AND operation_date < ?
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
    `).bind(
      partner.id, tx.currency, txMajor, dayStart, dayEnd,
    ).first<{ id: string; reference: string }>();

    if (existingServiceOp?.id) {
      const opId = existingServiceOp.id;
      const attIds = await attachPaymentAndInvoice(env, { operation_id: opId, tx });
      await persistOutcome(env, txId, 'auto_service_closed', opId);
      return {
        outcome: 'auto_service_closed',
        operation_id: opId,
        partner_id: partner.id,
        attachment_ids: attIds,
        reason: `linked to existing ${existingServiceOp.reference}`,
      };
    }

    // No existing service op found — DO NOT create one from this bank tx.
    // Park as awaiting_invoice; the op will arrive via invoice/act inbox.
    await persistOutcome(env, txId, 'awaiting_invoice', null);
    return {
      outcome: 'awaiting_invoice',
      operation_id: null,
      partner_id: partner.id,
      attachment_ids: [],
      reason: `service tx for ${partner.id} — awaiting invoice/act for allocation`,
    };
  }

  // Goods or incoming — search candidate operations
  const candidates = await findCandidateOperations(env, {
    partner_id: partner.id,
    txMajor,
    currency: tx.currency,
    executed_at: tx.executed_at,
  });

  if (candidates.length === 1) {
    const op = candidates[0]!;
    const attIds = await attachPaymentAndInvoice(env, { operation_id: op.id, tx });
    await persistOutcome(env, txId, 'auto_matched', op.id);
    return {
      outcome: 'auto_matched',
      operation_id: op.id,
      partner_id: partner.id,
      attachment_ids: attIds,
    };
  }

  // GUARD (Aram 2026-05-21): Marketplace settlements from Ozon / WB /
  // No candidate operation found — DO NOT auto-create one from this bank tx.
  // Universal rule: operations are created from invoices/acts (via inbox-ingestion
  // or marketplace report sync), never from bank tx. Park as awaiting_invoice
  // for later allocation when the corresponding op arrives.
  if (candidates.length === 0) {
    // Marketplace settlements get their own outcome label for filtering in the UI;
    // semantically identical to awaiting_invoice (both wait for an op to arrive).
    const MARKETPLACE_SETTLEMENT_PARTNERS = new Set([
      'ozon', 'wb',
      'яндекс_пей_продажи_с_нашего_сайта', // dasexperten.ru via Yandex Pay
    ]);
    const isMarketplace =
      tx.direction === 'incoming' &&
      MARKETPLACE_SETTLEMENT_PARTNERS.has(partner.id);
    const outcome: MatchOutcome = isMarketplace
      ? 'awaiting_marketplace_settlement'
      : 'awaiting_invoice';
    await persistOutcome(env, txId, outcome, null);
    return {
      outcome,
      operation_id: null,
      partner_id: partner.id,
      attachment_ids: [],
      reason: isMarketplace
        ? 'awaiting marketplace report sync'
        : 'awaiting invoice/act for allocation',
    };
  }

  // 2+ candidates — try to disambiguate by date proximity before giving up.
  // Rule: if the closest candidate is within 14 days of the bank tx AND the next-closest
  // is at least 21 days further than the closest, the answer is unambiguous: pick closest.
  // Example: tx 28 Apr, candidate A on 24 Apr (Δ=4d), candidate B on 26 Feb (Δ=61d).
  // 4d <= 14d && (61 - 4) >= 21 → pick A. This is the case Aram flagged.
  const candidatesWithDelta = candidates
    .map((op) => ({
      op,
      delta: Math.abs(op.operation_date - tx.executed_at),
    }))
    .sort((a, b) => a.delta - b.delta);

  const closest = candidatesWithDelta[0]!;
  const next = candidatesWithDelta[1]!;
  const closestDays = closest.delta / 86400;
  const nextDays = next.delta / 86400;

  if (closestDays <= 14 && nextDays - closestDays >= 21) {
    // Unambiguous winner — auto-attach.
    const attIds = await attachPaymentAndInvoice(env, { operation_id: closest.op.id, tx });
    await persistOutcome(env, txId, 'auto_matched', closest.op.id);
    return {
      outcome: 'auto_matched',
      operation_id: closest.op.id,
      partner_id: partner.id,
      attachment_ids: attIds,
    };
  }

  // Genuine ambiguity — fall back to manual review.
  const orphanId = await createOrphanAttachment(env, {
    tx,
    notes: `ambiguous: ${candidates.length} candidates: ${candidates.map((c) => c.reference).join(', ')}`,
  });
  await persistOutcome(env, txId, 'ambiguous', null);
  return {
    outcome: 'ambiguous',
    operation_id: null,
    partner_id: partner.id,
    attachment_ids: [orphanId],
    candidate_ids: candidates.map((c) => c.id),
  };
}

// ---- private helpers ------------------------------------------------------

interface PartnerRow {
  id: string;
  trade_name: string;
  legal_name: string;
  currency: string;
  kind: string;
  partner_type: string;
}

// INN aliases: factoring banks / payment processors that pay on behalf of
// a marketplace. When tx arrives with one of these INNs, route to the
// canonical marketplace partner so it gets parked as awaiting_marketplace_settlement
// (not partner_not_found) and FIFO allocator can pick it up later.
//
// Mirror of marketplace-fifo-allocator.PARTNER_ALIASES — keep these two in sync.
const INN_TO_PARTNER_ALIAS: Record<string, string> = {
  '9703026898': 'ozon', // OZON МКК Credit — pays for Ozon sales
  '7802754982': 'ozon', // Сбербанк Факторинг — pays for Ozon contract ИНН 7704217370
  '7702045051': 'ozon', // МТС-Банк — pays for Ozon contract ИР-34138/22
};

async function findPartnerByInn(env: Env, inn: string): Promise<PartnerRow | null> {
  if (!inn || inn.length < 9) return null;

  // Alias check first: if this INN is a known factoring/processor, return the
  // canonical marketplace partner (typically 'ozon').
  const aliasId = INN_TO_PARTNER_ALIAS[inn];
  if (aliasId) {
    const aliasRow = await env.DB.prepare(`
      SELECT id, trade_name, legal_name, currency, kind, partner_type
      FROM partners
      WHERE id = ?
        AND (deleted_at IS NULL OR deleted_at = 0)
      LIMIT 1
    `).bind(aliasId).first<PartnerRow>();
    if (aliasRow) return aliasRow;
  }

  const row = await env.DB.prepare(`
    SELECT id, trade_name, legal_name, currency, kind, partner_type
    FROM partners
    WHERE (tax_id = ? OR inn = ?)
      AND (deleted_at IS NULL OR deleted_at = 0)
    LIMIT 1
  `).bind(inn, inn).first<PartnerRow>();
  return row || null;
}

// =============================================================================
// findPartnerByContractInNarration — resolve partner via contract_no in text.
//
// Why: SWIFT MT103 transactions routed through correspondent banks (VTB →
// Honghui, e.g.) carry the bank's INN as contragent_inn and the bank's name
// as contragent_name. The real beneficiary appears only inside payment_purpose
// as "CONTRACT 080824 DD 09.04.2024 INVOICE: HA25110 ...". We parse the
// contract number out of that narration, look it up in the contracts table,
// and return the linked partner.
//
// Supported patterns (case-insensitive):
//   CONTRACT 080824
//   CONTRACT NO 080824
//   CONTRACT № 080824
//   CONTRACT N. 080824
//   договор 080824
//   ДОГОВОР № 080824
// Contract numbers may contain digits, letters, slashes, dashes (080824/A1).
// =============================================================================
export function extractContractNoFromNarration(narration: string): string | null {
  if (!narration) return null;
  // Match "CONTRACT" or "ДОГОВОР" + optional NO/N/№/# + alphanumeric token.
  // Token must (a) start with a digit OR letter, (b) be 3-31 chars, and
  // (c) contain at least one digit somewhere (excludes "DD", "FROM", "ADV", etc.).
  const re = /(?:CONTRACT|ДОГОВОР)\s*(?:N[O.]?|№|#)?\s*[:.]?\s*([0-9A-Za-z][0-9A-Za-z\/\-_]{2,30})/gi;
  for (const m of narration.matchAll(re)) {
    if (!m[1]) continue;
    const candidate = m[1].replace(/[.,;:]+$/, '').trim();
    // Must contain at least one digit — guards against
    // "CONTRACT DD 01.04.2025" where "DD" would otherwise match.
    if (!/\d/.test(candidate)) continue;
    // Common false-positives that follow CONTRACT keyword.
    if (/^(DD|FROM|ADV|GOODS|PMT|INVOICE|DATE)$/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

async function findPartnerByContractInNarration(
  env: Env,
  narration: string,
): Promise<PartnerRow | null> {
  const contractNo = extractContractNoFromNarration(narration);
  if (!contractNo) return null;

  // Try exact match first (e.g. "080824/A1")
  let row = await env.DB.prepare(`
    SELECT p.id, p.trade_name, p.legal_name, p.currency, p.kind, p.partner_type
    FROM contracts c
    JOIN partners p ON p.id = c.partner_id
                    AND (p.deleted_at IS NULL OR p.deleted_at = 0)
    WHERE c.contract_no = ?
      AND (c.deleted_at IS NULL OR c.deleted_at = 0)
    LIMIT 1
  `).bind(contractNo).first<PartnerRow>();

  // If exact didn't match and the contract has a suffix (e.g. "080824/A1"),
  // fall back to the head segment "080824" — annexes share the partner.
  if (!row && contractNo.includes('/')) {
    const head = contractNo.split('/')[0];
    row = await env.DB.prepare(`
      SELECT p.id, p.trade_name, p.legal_name, p.currency, p.kind, p.partner_type
      FROM contracts c
      JOIN partners p ON p.id = c.partner_id
                      AND (p.deleted_at IS NULL OR p.deleted_at = 0)
      WHERE c.contract_no = ?
        AND (c.deleted_at IS NULL OR c.deleted_at = 0)
      LIMIT 1
    `).bind(head).first<PartnerRow>();
  }

  return row || null;
}

async function createDraftPartner(
  env: Env,
  args: {
    trade_name: string;
    legal_name: string;
    tax_id: string;
    currency: string;
    kind: string;
  },
): Promise<string> {
  const id = await generateReadablePartnerId(env, args.trade_name);
  const now = Math.floor(Date.now() / 1000);
  const slug = id; // slug mirrors id — both human-readable, both unique

  await env.DB.prepare(`
    INSERT INTO partners (
      id, trade_name, legal_name, tax_id, inn, currency, kind,
      partner_type, status, crm_status, partner_language,
      has_dual_route_banking, is_packaging_manufacturer, is_legal_seller,
      slug, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'other', 'active', 'lead', 'RU',
              0, 0, 0, ?, ?, ?, ?)
  `).bind(
    id, args.trade_name, args.legal_name, args.tax_id, args.tax_id,
    args.currency, args.kind, slug,
    '[AUTO-CREATED from Modulbank webhook, no INN/name match — please verify & categorise]',
    now, now,
  ).run();
  return id;
}

interface CandidateOp {
  id: string;
  reference: string;
  total_amount: number;
  currency: string;
  operation_date: number;
  status: string;
  fx_rate_to_usd?: number;
}

async function findCandidateOperations(
  env: Env,
  args: {
    partner_id: string;
    txMajor: number;
    currency: string;
    executed_at: number;
  },
): Promise<CandidateOp[]> {
  const windowSec = DATE_WINDOW_DAYS * 86400;
  const minDate = args.executed_at - windowSec;
  const maxDate = args.executed_at + windowSec;

  const exact = await env.DB.prepare(`
    SELECT id, reference, total_amount, currency, operation_date, status
    FROM operations
    WHERE partner_id = ?
      AND status NOT IN ('cancelled', 'delivered')
      AND (deleted_at IS NULL OR deleted_at = 0)
      AND operation_date BETWEEN ? AND ?
      AND currency = ?
      AND ABS(total_amount - ?) < 0.01
  `).bind(args.partner_id, minDate, maxDate, args.currency, args.txMajor)
    .all<CandidateOp>();

  if ((exact.results || []).length > 0) return exact.results || [];

  const fx = await env.DB.prepare(`
    SELECT id, reference, total_amount, currency, operation_date, status, fx_rate_to_usd
    FROM operations
    WHERE partner_id = ?
      AND status NOT IN ('cancelled', 'delivered')
      AND (deleted_at IS NULL OR deleted_at = 0)
      AND operation_date BETWEEN ? AND ?
      AND currency != ?
      AND fx_rate_to_usd > 0
  `).bind(args.partner_id, minDate, maxDate, args.currency)
    .all<CandidateOp & { fx_rate_to_usd: number }>();

  const rate = await getFxRateToUsd(env, args.currency, args.executed_at);
  if (!rate || rate <= 0) return [];
  const txUsdMajor = args.txMajor / rate;
  return (fx.results || []).filter((op) => {
    const opRate = (op.fx_rate_to_usd || 0) / 10000;
    if (opRate <= 0) return false;
    const opUsdMajor = op.total_amount / opRate;
    if (txUsdMajor === 0) return false;
    const diff = Math.abs(opUsdMajor - txUsdMajor) / txUsdMajor;
    return diff <= FX_TOLERANCE_PCT;
  });
}

async function createServiceOperation(
  env: Env,
  args: {
    partner_id: string;
    amount_major: number;
    currency: string;
    operation_date: number;
    purpose: string;
    contragent_name: string;
    invoice_no?: string | null;
  },
): Promise<string> {
  const opId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  // Tax authorities (ФНС, ФТС) get operation_type='tax' — they are obligations
  // to the state, not service purchases. Everyone else with kind=service_provider
  // gets operation_type='service'.
  const isTaxAuthority = args.partner_id === 'fns' || args.partner_id === 'fts';
  const opType: 'service' | 'tax' = isTaxAuthority ? 'tax' : 'service';

  const reference = await nextOperationReference(env, args.operation_date, {
    partner_id: args.partner_id,
    operation_type: opType,
    invoice_no: args.invoice_no,
  });
  const desc = extractServiceDescription(args.purpose);
  const notes = `[${opType.toUpperCase()} — auto-closed] ${desc || args.contragent_name}`;

  await env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id,
      our_company_id, status, currency, total_amount,
      notes, reference, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'dee', 'issued', ?, ?, ?, ?, ?, ?)
  `).bind(
    opId, args.operation_date, opType, args.partner_id,
    args.currency, args.amount_major,
    notes, reference, now, now,
  ).run();
  return opId;
}

async function createDraftGoodsOperation(
  env: Env,
  args: {
    partner_id: string;
    amount_major: number;
    currency: string;
    operation_date: number;
    direction: string;
    notes: string;
    invoice_no?: string | null;
  },
): Promise<string> {
  const opId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const operationType = args.direction === 'incoming' ? 'sale' : 'purchase';
  const reference = await nextOperationReference(env, args.operation_date, {
    partner_id: args.partner_id,
    operation_type: operationType,
    invoice_no: args.invoice_no,
  });

  await env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id,
      our_company_id, status, currency, total_amount,
      notes, reference, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'dee', 'issued', ?, ?, ?, ?, ?, ?)
  `).bind(
    opId, args.operation_date, operationType, args.partner_id,
    args.currency, args.amount_major,
    args.notes, reference, now, now,
  ).run();
  return opId;
}

async function nextOperationReference(
  env: Env,
  opDate: number,
  opts?: {
    partner_id?: string;
    operation_type?: 'sale' | 'purchase' | 'transfer' | 'service' | 'tax';
    invoice_no?: string | null;
  },
): Promise<string> {
  const dt = new Date(opDate * 1000);
  const yy = String(dt.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');

  // RULE (Aram, 2026-05-21): when an operation involves a known counterpart
  // partner, the reference uses the PARTNER's abbreviation, not our own DEE/DEI.
  // Applies to ALL operation types: purchase, sale, service, tax, transfer.
  // DEE/DEI fallback is reserved for operations without a partner counterpart.
  if (opts?.partner_id) {
    const partner = await env.DB.prepare(
      `SELECT abbreviation FROM partners WHERE id = ?`
    ).bind(opts.partner_id).first<{ abbreviation: string | null }>();

    if (partner?.abbreviation) {
      const datePart = `${dt.getUTCFullYear()}${mm}${dd}`;
      const prefix = `${partner.abbreviation}-${datePart}`;
      // With known invoice number — embed it for stable refs
      if (opts.invoice_no) {
        const safeInvNo = String(opts.invoice_no).replace(/[^A-Za-z0-9_-]/g, '');
        let ref = `${prefix}-${safeInvNo}`;
        let suffix = '';
        let i = 0;
        while (true) {
          const tryRef = ref + suffix;
          const exists = await env.DB.prepare(
            `SELECT 1 FROM operations WHERE reference = ? LIMIT 1`
          ).bind(tryRef).first();
          if (!exists) return tryRef;
          suffix = '-' + String.fromCharCode(65 + i);
          i += 1;
          if (i > 25) break;
        }
      }
      // No invoice — use daily counter
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?`
      ).bind(`${prefix}-%`).first<{ cnt: number }>();
      const seq = ((row?.cnt ?? 0) + 1).toString().padStart(3, '0');
      return `${prefix}-${seq}`;
    }
  }

  // Fallback only when there's truly no counterpart partner.
  const prefix = `DEE-${yy}`;
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?
  `).bind(`${prefix}%`).first<{ cnt: number }>();
  const seq = ((row?.cnt ?? 0) + 1).toString().padStart(4, '0');
  return `${prefix}${seq}`;
}

async function attachPaymentAndInvoice(
  env: Env,
  args: {
    operation_id: string;
    tx: {
      id: string;
      direction: string;
      amount: number;
      currency: string;
      executed_at: number;
      contragent_name: string;
      payment_purpose: string;
      external_doc_number: string;
    };
  },
): Promise<string[]> {
  const ids: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  const pmtId = `att_${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO operation_attachments (
      id, operation_id, direction, kind, doc_number, doc_date,
      amount, currency, issuer, parsed_from, source_ref_id,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, 'webhook', ?, ?, ?, ?)
  `).bind(
    pmtId, args.operation_id, args.tx.direction,
    args.tx.external_doc_number || null, args.tx.executed_at,
    toMajor(args.tx.amount, args.tx.currency), args.tx.currency,
    args.tx.contragent_name || 'Modulbank',
    args.tx.id,
    args.tx.payment_purpose ? args.tx.payment_purpose.slice(0, 500) : null,
    now, now,
  ).run();
  ids.push(pmtId);

  const parsed = parseInvoiceFromPurpose(args.tx.payment_purpose);
  if (parsed) {
    const invDirection = args.tx.direction === 'outgoing' ? 'incoming' : 'outgoing';
    const invId = `att_${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO operation_attachments (
        id, operation_id, direction, kind, doc_number, doc_date,
        amount, currency, issuer, parsed_from, source_ref_id,
        notes, created_at, updated_at
      ) VALUES (?, ?, ?, 'invoice', ?, ?, ?, ?, ?, 'webhook', ?, ?, ?, ?)
    `).bind(
      invId, args.operation_id, invDirection,
      parsed.doc_number, parsed.doc_date,
      toMajor(args.tx.amount, args.tx.currency), args.tx.currency,
      args.tx.contragent_name || null,
      args.tx.id,
      'parsed from payment_purpose',
      now, now,
    ).run();
    ids.push(invId);
  }
  return ids;
}

async function createOrphanAttachment(
  env: Env,
  args: {
    tx: {
      id: string;
      direction: string;
      amount: number;
      currency: string;
      executed_at: number;
      contragent_name: string;
      external_doc_number: string;
    };
    notes: string;
  },
): Promise<string> {
  const id = `att_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO operation_attachments (
      id, operation_id, direction, kind, doc_number, doc_date,
      amount, currency, issuer, parsed_from, source_ref_id,
      notes, created_at, updated_at
    ) VALUES (?, NULL, ?, 'payment', ?, ?, ?, ?, ?, 'webhook', ?, ?, ?, ?)
  `).bind(
    id, args.tx.direction,
    args.tx.external_doc_number || null, args.tx.executed_at,
    toMajor(args.tx.amount, args.tx.currency), args.tx.currency,
    args.tx.contragent_name || 'Modulbank',
    args.tx.id,
    args.notes,
    now, now,
  ).run();
  return id;
}

async function persistOutcome(
  env: Env,
  txId: string,
  method: MatchOutcome,
  operationId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    UPDATE bank_transactions
    SET matched_operation_id = ?,
        match_method = ?,
        matched_at = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(operationId, method, operationId ? now : null, now, txId).run();
}

// =============================================================================
// rebalanceMisattributedMatches — find bank_txs matched to an operation that's
// far in time, when another operation with the same partner + exact amount + currency
// exists within ±14 days of the tx. Re-assigns to the closer match.
//
// Catches the case where bank_tx ran auto-match BEFORE the correct operation was
// created (e.g. invoice uploaded after payment came in). System originally matched
// to an older invoice with the same amount; we now have a better answer.
//
// Conservative: requires the existing match to be >30 days off AND the new candidate
// to be within ±14 days. No other amount-fuzz allowed.
// =============================================================================
export async function rebalanceMisattributedMatches(
  env: Env,
): Promise<{ scanned: number; rebalanced: number; refs: { from: string; to: string }[] }> {
  const out = { scanned: 0, rebalanced: 0, refs: [] as { from: string; to: string }[] };

  // Suspects: matched_operation_id set, but operation is >30 days from tx date.
  const suspects = await env.DB.prepare(`
    SELECT bt.id as tx_id, bt.executed_at, bt.amount, bt.currency,
           o.id as matched_op_id, o.reference as matched_ref, o.partner_id
      FROM bank_transactions bt
      JOIN operations o ON o.id = bt.matched_operation_id
     WHERE bt.matched_operation_id IS NOT NULL
       AND ABS(o.operation_date - bt.executed_at) > 30 * 86400
       AND bt.executed_at > strftime('%s','now','-180 days')
       AND (bt.deleted_at IS NULL OR bt.deleted_at = 0)
     LIMIT 500
  `).all<{
    tx_id: string; executed_at: number; amount: number; currency: string;
    matched_op_id: string; matched_ref: string; partner_id: string;
  }>();

  out.scanned = suspects.results?.length ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const s of suspects.results ?? []) {
    const txMajor = toMajor(s.amount, s.currency);
    const better = await env.DB.prepare(`
      SELECT id, reference
        FROM operations
       WHERE partner_id = ?
         AND id != ?
         AND status NOT IN ('cancelled','delivered')
         AND (deleted_at IS NULL OR deleted_at = 0)
         AND currency = ?
         AND ABS(total_amount - ?) < 0.01
         AND ABS(operation_date - ?) < 14 * 86400
       ORDER BY ABS(operation_date - ?) ASC
       LIMIT 1
    `).bind(
      s.partner_id, s.matched_op_id, s.currency, txMajor, s.executed_at, s.executed_at
    ).first<{ id: string; reference: string }>();

    if (!better) continue;

    // Re-attach: update bank_tx + move operation_attachments
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE bank_transactions
           SET matched_operation_id = ?,
               match_method = 'auto_rebalanced',
               matched_at = ?,
               updated_at = ?
         WHERE id = ?
      `).bind(better.id, nowSec, nowSec, s.tx_id),
      env.DB.prepare(`
        UPDATE operation_attachments
           SET operation_id = ?,
               updated_at = ?
         WHERE source_ref_id = ?
      `).bind(better.id, nowSec, s.tx_id),
    ]);

    out.rebalanced += 1;
    out.refs.push({ from: s.matched_ref, to: better.reference });
  }

  return out;
}

// =============================================================================
// retryUnmatchedTransactions — re-run auto-match for bank_txs still in
// 'ambiguous' or 'partner_not_found' state. Operations may have been created
// after the original webhook (e.g. invoice uploaded later), so we re-evaluate.
//
// Called by cron to give Aram a clean inbox without manual click-through.
// =============================================================================
export async function retryUnmatchedTransactions(
  env: Env,
): Promise<{ checked: number; resolved: number; refs: string[] }> {
  const out = { checked: 0, resolved: 0, refs: [] as string[] };

  // Pull txs in any unresolved state — never tried (NULL), explicitly ambiguous,
  // or partner_not_found. Operations may have been created later (manual invoice upload),
  // unlocking a single-candidate match now.
  const rows = await env.DB.prepare(`
    SELECT id, match_method
      FROM bank_transactions
     WHERE matched_operation_id IS NULL
       AND (match_method IS NULL
            OR match_method IN ('ambiguous', 'partner_not_found', 'partner_not_found_service'))
       AND executed_at > strftime('%s','now','-180 days')
       AND (deleted_at IS NULL OR deleted_at = 0)
     ORDER BY executed_at DESC
     LIMIT 500
  `).all<{ id: string; match_method: string | null }>();

  for (const row of rows.results ?? []) {
    out.checked += 1;
    try {
      const result = await autoMatchBankTransaction(env, row.id);
      if (result.outcome === 'auto_matched' || result.outcome === 'rule_matched') {
        out.resolved += 1;
        if (result.operation_id) {
          const op = await env.DB.prepare(
            `SELECT reference FROM operations WHERE id = ?`
          ).bind(result.operation_id).first<{ reference: string }>();
          if (op?.reference) out.refs.push(op.reference);
        }
      }
    } catch (e) {
      // best-effort sweep — log and continue
      console.error(`[retryUnmatched] tx ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}

async function getFxRateToUsd(
  env: Env,
  currency: string,
  unixTs: number,
): Promise<number | null> {
  if (currency === 'USD') return 1;
  const dateStr = new Date(unixTs * 1000).toISOString().slice(0, 10);
  const envAny = env as unknown as Record<string, KVNamespace | undefined>;
  const kv = envAny.FX || envAny.DAS_FX || envAny.KV_FX;
  if (!kv) return null;
  try {
    const cached = await kv.get(`fx:${dateStr}:${currency}`);
    if (cached) {
      const v = parseFloat(cached);
      if (v > 0) return v;
    }
    const latest = await kv.get(`fx:latest:${currency}`);
    if (latest) {
      const v = parseFloat(latest);
      if (v > 0) return v;
    }
  } catch {
    // KV miss
  }
  return null;
}

