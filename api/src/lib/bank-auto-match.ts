// =============================================================================
// Bank transaction → Operation auto-matcher
// =============================================================================
// Called from the Modulbank webhook handler (and potentially other bank
// integrations later). Tries to attach an incoming bank_transaction to an
// existing operation by INN + amount + date window. If exactly one candidate
// matches, attaches PMT (payment) and parsed INV (invoice) attachments to
// that operation. Otherwise creates an orphan PMT attachment that surfaces
// in the Inbox tab for manual handling.
//
// Match result is persisted on the bank_transactions row via the legacy
// fields `matched_payment_id` (now holds operation_id) and `match_method`
// (now holds a status: auto_matched | auto_created_draft | ambiguous |
// partner_not_found | no_candidate).
// =============================================================================

import type { Env } from '../types';

const DATE_WINDOW_DAYS = 30;
const FX_TOLERANCE_PCT = 0.01; // 1% for cross-currency matches

export type MatchOutcome =
  | 'auto_matched'
  | 'auto_created_draft'
  | 'ambiguous'
  | 'partner_not_found'
  | 'no_candidate';

export interface AutoMatchResult {
  outcome: MatchOutcome;
  operation_id: string | null;
  attachment_ids: string[];
  candidate_ids?: string[];
  reason?: string;
}

// -----------------------------------------------------------------------------
// Invoice parser — extracts invoice number + date from payment_purpose.
// Same regex family as the 2026-05-10 backfill that successfully parsed
// 187/188 RU payment purposes. Returns null when no match found.
// -----------------------------------------------------------------------------
const RU_MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

export function parseInvoiceFromPurpose(purpose: string): {
  doc_number: string;
  doc_date: number | null;
} | null {
  if (!purpose) return null;

  // Variant 1: "счёт № X от DD месяц YYYY"  (most common, RU)
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

  // Variant 2: "счёт № X от DD.MM.YYYY"
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

  // Variant 3: "invoice X" / "inv X" (EN fallback, no date)
  const re3 = /\b(?:invoice|inv\.?)\s*[№#]?\s*([A-Za-z0-9\-\/_.]+)/i;
  const m3 = purpose.match(re3);
  if (m3 && m3[1]) {
    return { doc_number: m3[1].trim(), doc_date: null };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Main entry point. Called immediately after a bank_transaction row is
// inserted. Returns the outcome but never throws — webhook handler must
// return 200 to Modulbank even if matching fails (the tx is already stored).
// -----------------------------------------------------------------------------
export async function autoMatchBankTransaction(
  env: Env,
  txId: string,
): Promise<AutoMatchResult> {
  // 1. Load the bank_transaction row we just inserted.
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

  // 2. Find partner by INN.
  if (!tx.contragent_inn || tx.contragent_inn.length < 9) {
    await persistOutcome(env, txId, 'partner_not_found', null);
    return { outcome: 'partner_not_found', operation_id: null, attachment_ids: [], reason: 'no INN on tx' };
  }

  const partner = await env.DB.prepare(`
    SELECT id, trade_name, legal_name, currency
    FROM partners
    WHERE tax_id = ? AND (deleted_at IS NULL OR deleted_at = 0)
    LIMIT 1
  `).bind(tx.contragent_inn).first<{
    id: string;
    trade_name: string;
    legal_name: string;
    currency: string;
  }>();

  if (!partner) {
    await persistOutcome(env, txId, 'partner_not_found', null);
    return {
      outcome: 'partner_not_found',
      operation_id: null,
      attachment_ids: [],
      reason: `no partner with tax_id=${tx.contragent_inn}`,
    };
  }

  // 3. Find candidate operations.
  const windowSec = DATE_WINDOW_DAYS * 86400;
  const minDate = tx.executed_at - windowSec;
  const maxDate = tx.executed_at + windowSec;

  // First pass: exact currency + exact amount (to the kopek/cent).
  const exactCandidates = await env.DB.prepare(`
    SELECT id, reference, total_amount, currency, operation_date, status
    FROM operations
    WHERE partner_id = ?
      AND status NOT IN ('cancelled', 'delivered')
      AND (deleted_at IS NULL OR deleted_at = 0)
      AND operation_date BETWEEN ? AND ?
      AND currency = ?
      AND total_amount = ?
  `).bind(partner.id, minDate, maxDate, tx.currency, tx.amount)
    .all<{ id: string; reference: string; total_amount: number; currency: string; operation_date: number; status: string }>();

  let candidates = exactCandidates.results || [];

  // Second pass: cross-currency with FX tolerance, only if no exact matches found.
  if (candidates.length === 0) {
    const fxCandidates = await env.DB.prepare(`
      SELECT id, reference, total_amount, currency, operation_date, status, fx_rate_to_usd
      FROM operations
      WHERE partner_id = ?
        AND status NOT IN ('cancelled', 'delivered')
        AND (deleted_at IS NULL OR deleted_at = 0)
        AND operation_date BETWEEN ? AND ?
        AND currency != ?
        AND fx_rate_to_usd > 0
    `).bind(partner.id, minDate, maxDate, tx.currency)
      .all<{ id: string; reference: string; total_amount: number; currency: string; operation_date: number; status: string; fx_rate_to_usd: number }>();

    // FX rates are stored as INTEGER (scaled). Operations layer typically scales
    // by 10000 (e.g. 88.5 RUB/USD → 885000). We accept ±FX_TOLERANCE_PCT.
    // Tx amount is in minor units; total_amount is in minor units. Compare USD-equiv.
    const txCurrencyRate = await getFxRateToUsd(env, tx.currency, tx.executed_at);
    if (txCurrencyRate && txCurrencyRate > 0) {
      const txUsdMinor = tx.amount / txCurrencyRate;
      candidates = (fxCandidates.results || []).filter((op) => {
        const opUsdMinor = op.total_amount / (op.fx_rate_to_usd / 10000);
        const diff = Math.abs(opUsdMinor - txUsdMinor) / txUsdMinor;
        return diff <= FX_TOLERANCE_PCT;
      });
    }
  }

  // 4. Dispatch by candidate count.
  if (candidates.length === 0) {
    // Create a draft operation and attach PMT + parsed INV to it.
    const draftOpId = await createDraftOperation(env, {
      partner_id: partner.id,
      amount: tx.amount,
      currency: tx.currency,
      operation_date: tx.executed_at,
      notes: `auto-created from unmatched bank_tx ${txId} (${tx.contragent_name})`,
      direction: tx.direction,
    });

    const attachmentIds = await attachPaymentAndInvoice(env, {
      operation_id: draftOpId,
      tx,
    });

    await persistOutcome(env, txId, 'auto_created_draft', draftOpId);
    return {
      outcome: 'auto_created_draft',
      operation_id: draftOpId,
      attachment_ids: attachmentIds,
    };
  }

  if (candidates.length === 1) {
    const op = candidates[0];
    if (!op) {
      // Defensive — shouldn't happen given length check, but TS narrowing demands it.
      await persistOutcome(env, txId, 'no_candidate', null);
      return { outcome: 'no_candidate', operation_id: null, attachment_ids: [] };
    }
    const attachmentIds = await attachPaymentAndInvoice(env, {
      operation_id: op.id,
      tx,
    });

    await persistOutcome(env, txId, 'auto_matched', op.id);
    return {
      outcome: 'auto_matched',
      operation_id: op.id,
      attachment_ids: attachmentIds,
    };
  }

  // 2+ candidates — ambiguous. Create orphan PMT attachment for Inbox.
  const orphanId = await createOrphanAttachment(env, {
    tx,
    notes: `ambiguous: ${candidates.length} candidates: ${candidates.map((c) => c.reference).join(', ')}`,
  });

  await persistOutcome(env, txId, 'ambiguous', null);
  return {
    outcome: 'ambiguous',
    operation_id: null,
    attachment_ids: [orphanId],
    candidate_ids: candidates.map((c) => c.id),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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
  // FX is optional — if no KV binding present, skip cross-currency matching.
  // Try common binding names; degrade gracefully.
  const envAny = env as unknown as Record<string, KVNamespace | undefined>;
  const kv = envAny.DAS_FX || envAny.FX || envAny.KV_FX || envAny.das_fx;
  if (!kv) return null;
  try {
    const cached = await kv.get(`fx:${dateStr}:${currency}`);
    if (cached) {
      const parsed = parseFloat(cached);
      if (parsed > 0) return parsed;
    }
    const latest = await kv.get(`fx:latest:${currency}`);
    if (latest) {
      const parsed = parseFloat(latest);
      if (parsed > 0) return parsed;
    }
  } catch {
    // KV miss — return null, downstream skips FX matching
  }
  return null;
}

async function createDraftOperation(
  env: Env,
  args: {
    partner_id: string;
    amount: number;
    currency: string;
    operation_date: number;
    notes: string;
    direction: string;
  },
): Promise<string> {
  const opId = `op_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  // Generate reference: DEE-{YY}{NNNN}. We pick DEE as default issuer for
  // bank-originated drafts because Modulbank is the DEE bank account.
  const yy = new Date(args.operation_date * 1000).getFullYear() % 100;
  const seqRow = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?
  `).bind(`DEE-${String(yy).padStart(2, '0')}%`).first<{ cnt: number }>();
  const seq = ((seqRow?.cnt ?? 0) + 1).toString().padStart(4, '0');
  const reference = `DEE-${String(yy).padStart(2, '0')}${seq}`;

  // operation_type: bank-derived drafts → 'purchase' if outgoing payment (we paid),
  // 'sale' if incoming (customer paid us). Status: needs_review.
  const operationType = args.direction === 'outgoing' ? 'purchase' : 'sale';

  await env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id,
      our_company_id, status, currency, total_amount,
      notes, reference, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'needs_review', ?, ?, ?, ?, ?, ?)
  `).bind(
    opId, args.operation_date, operationType, args.partner_id,
    'co_dee', // DEE is the default Modulbank account holder; adjust if multi-entity
    args.currency, args.amount,
    args.notes, reference, now, now,
  ).run();

  return opId;
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

  // PMT attachment — always created.
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

  // INV attachment — only if we can parse the invoice ref out of payment_purpose.
  const parsed = parseInvoiceFromPurpose(args.tx.payment_purpose);
  if (parsed) {
    // Invoice direction is OPPOSITE of payment direction:
    // outgoing payment → we received an incoming invoice (supplier billed us)
    // incoming payment → we sent an outgoing invoice (we billed customer)
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
