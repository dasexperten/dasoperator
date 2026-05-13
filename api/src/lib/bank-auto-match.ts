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
  | 'bank_self_reference_skipped';

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

  const re3 = /\b(?:invoice|inv\.?)\s*[№#]?\s*([A-Za-z0-9\-\/_.]+)/i;
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

      // No open op found — create new one based on category default_operation_type
      if (decision.default_operation_type === 'purchase' && decision.partner_id) {
        const opId = await createServiceOperation(env, {
          partner_id: decision.partner_id,
          amount_major: tx.amount / 100,
          currency: tx.currency,
          operation_date: tx.executed_at,
          purpose: tx.payment_purpose,
          contragent_name: tx.contragent_name,
        });
        const attIds = await attachPaymentAndInvoice(env, { operation_id: opId, tx });
        await persistOutcome(env, txId, 'rule_matched' as MatchOutcome, opId);
        if (decision.matched_rule_id) await recordRuleHit(env, decision.matched_rule_id);
        return {
          outcome: 'rule_matched' as MatchOutcome,
          operation_id: opId,
          partner_id: decision.partner_id,
          attachment_ids: attIds,
          reason: `Auto-classified & created new op: ${decision.reason}`,
        };
      }
    }

    // For 'inbox_suggest' or 'inbox_blank' actions: fall through to old cascade
    // (which will leave the tx in Inbox; UI reads suggested_category_id from DB).
  } catch (e) {
    console.error('[bank-auto-match] classifier failed, falling through:', e);
  }

  // STEP 1
  let partner = await findPartnerByInn(env, tx.contragent_inn);

  // STEP 1a — INN miss: try fuzzy trade_name match (foreign counterparties,
  // missing INN in bank statement, etc.). Prevents duplicate prt_draft_* rows
  // for the same real-world company on consecutive transactions.
  if (!partner && tx.contragent_name) {
    partner = await findExistingPartnerByName(env, tx.contragent_name);
    if (partner) {
      console.log('[bank-auto-match] matched by trade_name fallback:',
        tx.contragent_name, '→', partner.id);
    }
  }

  // STEP 1b — partner not found
  if (!partner) {
    // STEP 1b-pre — bank self-reference filter. If the bank webhook landed
    // its own name in contragent_name (commission charge, internal transfer,
    // bank fee, etc.), do NOT create a partner row. Banks belong in
    // bank_providers, not partners.
    if (tx.contragent_name && await isBankProviderName(env, tx.contragent_name)) {
      console.log('[bank-auto-match] skipping bank self-reference:', tx.contragent_name);
      await persistOutcome(env, txId, 'bank_self_reference_skipped', null);
      return {
        outcome: 'bank_self_reference_skipped' as MatchOutcome,
        operation_id: null,
        attachment_ids: [],
      };
    }

    if (isService && tx.direction === 'outgoing' && tx.contragent_name) {
      const newPartnerId = await createDraftPartner(env, {
        trade_name: tx.contragent_name,
        legal_name: tx.contragent_name,
        tax_id: tx.contragent_inn || '',
        currency: tx.currency,
        kind: 'service_provider',
      });
      const opId = await createServiceOperation(env, {
        partner_id: newPartnerId,
        amount_major: txMajor,
        currency: tx.currency,
        operation_date: tx.executed_at,
        purpose: tx.payment_purpose,
        contragent_name: tx.contragent_name,
      });
      const attIds = await attachPaymentAndInvoice(env, { operation_id: opId, tx });
      await persistOutcome(env, txId, 'partner_auto_created', opId);
      return {
        outcome: 'partner_auto_created',
        operation_id: opId,
        partner_id: newPartnerId,
        attachment_ids: attIds,
        reason: 'partner created from tx.contragent_name; verify in Inbox',
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
    const opId = await createServiceOperation(env, {
      partner_id: partner.id,
      amount_major: txMajor,
      currency: tx.currency,
      operation_date: tx.executed_at,
      purpose: tx.payment_purpose,
      contragent_name: tx.contragent_name,
    });
    const attIds = await attachPaymentAndInvoice(env, { operation_id: opId, tx });
    await persistOutcome(env, txId, 'auto_service_closed', opId);
    return {
      outcome: 'auto_service_closed',
      operation_id: opId,
      partner_id: partner.id,
      attachment_ids: attIds,
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

  if (candidates.length === 0) {
    const opId = await createDraftGoodsOperation(env, {
      partner_id: partner.id,
      amount_major: txMajor,
      currency: tx.currency,
      operation_date: tx.executed_at,
      direction: tx.direction,
      notes: `[AUTO-DRAFT] from bank_tx ${txId}. payment_purpose: ${(tx.payment_purpose || '').slice(0, 300)}`,
    });
    const attIds = await attachPaymentAndInvoice(env, { operation_id: opId, tx });
    await persistOutcome(env, txId, 'auto_created_draft', opId);
    return {
      outcome: 'auto_created_draft',
      operation_id: opId,
      partner_id: partner.id,
      attachment_ids: attIds,
    };
  }

  // 2+ candidates
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

async function findPartnerByInn(env: Env, inn: string): Promise<PartnerRow | null> {
  if (!inn || inn.length < 9) return null;
  const row = await env.DB.prepare(`
    SELECT id, trade_name, legal_name, currency, kind, partner_type
    FROM partners
    WHERE (tax_id = ? OR inn = ?)
      AND (deleted_at IS NULL OR deleted_at = 0)
    LIMIT 1
  `).bind(inn, inn).first<PartnerRow>();
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
  },
): Promise<string> {
  const opId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const reference = await nextOperationReference(env, args.operation_date);
  const desc = extractServiceDescription(args.purpose);
  const notes = `[SERVICE EXPENSE — auto-closed] ${desc || args.contragent_name}`;

  await env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id,
      our_company_id, status, currency, total_amount,
      notes, reference, created_at, updated_at
    )
    VALUES (?, ?, 'purchase', ?, 'co_dee', 'issued', ?, ?, ?, ?, ?, ?)
  `).bind(
    opId, args.operation_date, args.partner_id,
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
  },
): Promise<string> {
  const opId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const reference = await nextOperationReference(env, args.operation_date);
  const operationType = args.direction === 'incoming' ? 'sale' : 'purchase';

  await env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id,
      our_company_id, status, currency, total_amount,
      notes, reference, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'co_dee', 'issued', ?, ?, ?, ?, ?, ?)
  `).bind(
    opId, args.operation_date, operationType, args.partner_id,
    args.currency, args.amount_major,
    args.notes, reference, now, now,
  ).run();
  return opId;
}

async function nextOperationReference(env: Env, opDate: number): Promise<string> {
  const yy = new Date(opDate * 1000).getFullYear() % 100;
  const prefix = `DEE-${String(yy).padStart(2, '0')}`;
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
    args.tx.amount / 100, args.tx.currency,
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
      args.tx.amount / 100, args.tx.currency,
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
    args.tx.amount / 100, args.tx.currency,
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
    SET matched_payment_id = ?,
        match_method = ?,
        matched_at = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(operationId, method, operationId ? now : null, now, txId).run();
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
