// ============================================================================
// bank-tx-allocator.ts
// ----------------------------------------------------------------------------
// When an operation is created from an invoice/act (via inbox-ingestion,
// document extraction, manual UI, or bundle auto-create), scan
// bank_transactions parked with match_method='awaiting_invoice' (or
// 'awaiting_marketplace_settlement' for marketplace sale ops) and attach any
// that match by amount + currency + partner + date window.
//
// This is the *forward* trigger — when invoice arrives. The *reverse* trigger
// (bank tx arrives, search ops) is in bank-auto-match.ts findCandidateOperations.
//
// Match criteria (must ALL be true):
//   • currency identical
//   • amount within ±1% of operation.total_amount (handles VAT rounding)
//   • partner matches: bank_tx.contragent_inn == partner.tax_id
//     OR (partner has no tax_id AND bank_tx.contragent_name contains partner.trade_name)
//   • bank_tx.executed_at within [op.operation_date - 90d, op.operation_date + 90d]
//   • bank_tx not yet matched_operation_id
//
// On match:
//   • UPDATE bank_transactions.matched_operation_id = op_id,
//                              .match_method = 'auto_allocated_on_op_create'
//   • INSERT into operation_attachments (kind='payment', source_ref_id=tx.id)
// ============================================================================

import type { Env } from '../types';

interface BankTxRow {
  id: string;
  amount: number; // MINOR units (kopecks for RUB, cents for USD/CNY)
  currency: string;
  contragent_inn: string | null;
  contragent_name: string | null;
  executed_at: number;
  payment_purpose: string | null;
  direction: string;
  external_doc_number: string | null;
}

interface AllocatorResult {
  attached_tx_ids: string[];
  attached_count: number;
  debug?: any;
}

const DATE_WINDOW_SECONDS = 90 * 86400; // ±90 days
const AMOUNT_TOLERANCE_PCT = 0.01; // ±1%

export async function allocateAwaitingTxToOperation(
  env: Env,
  operationId: string,
  debug: boolean = false,
): Promise<AllocatorResult> {
  const op = await env.DB.prepare(
    `SELECT o.id, o.total_amount, o.currency, o.operation_date, o.partner_id,
            o.operation_type,
            p.tax_id AS partner_inn, p.legal_name AS partner_legal, p.trade_name AS partner_trade
       FROM operations o
       LEFT JOIN partners p ON p.id = o.partner_id
      WHERE o.id = ? AND o.deleted_at IS NULL`,
  ).bind(operationId).first<{
    id: string;
    total_amount: number;
    currency: string;
    operation_date: number;
    partner_id: string | null;
    operation_type: string;
    partner_inn: string | null;
    partner_legal: string | null;
    partner_trade: string | null;
  }>();

  if (!op || !op.partner_id) {
    return { attached_tx_ids: [], attached_count: 0, debug: debug ? { reason: 'no_op_or_no_partner', op } : undefined };
  }

  // Skip ops with zero/null total (image-scan invoices where amount is set
  // at payment-match time). For those, the bank tx will still be the source
  // of truth, so we allocate by partner + date only (amount window collapses
  // to "any amount" if op.total_amount is 0).
  const opTotalMajor = op.total_amount ?? 0;
  const useAmountFilter = opTotalMajor > 0;

  // Convert op total (decimal major) to MINOR units to compare with bank_tx.amount
  // For VND/JPY/KRW (no subdivision), minor=major. Treat RUB/USD/CNY as ×100.
  const NO_SUBDIVISION = new Set(['VND', 'JPY', 'KRW']);
  const minorFactor = NO_SUBDIVISION.has(op.currency) ? 1 : 100;
  const opAmountMinor = Math.round(opTotalMajor * minorFactor);
  const tolerance = Math.max(1, Math.round(opAmountMinor * AMOUNT_TOLERANCE_PCT));
  const amountMin = opAmountMinor - tolerance;
  const amountMax = opAmountMinor + tolerance;

  const dateMin = op.operation_date - DATE_WINDOW_SECONDS;
  const dateMax = op.operation_date + DATE_WINDOW_SECONDS;

  // Direction matches operation_type:
  //   sale  → incoming (we receive money from buyer)
  //   purchase / service / tax → outgoing (we pay vendor)
  //   transfer → no bank tx involvement
  const expectedDirection =
    op.operation_type === 'sale' ? 'incoming' :
    op.operation_type === 'transfer' ? null :
    'outgoing';

  if (!expectedDirection) {
    return { attached_tx_ids: [], attached_count: 0, debug: debug ? { reason: 'no_direction', op_type: op.operation_type } : undefined };
  }

  // Build the WHERE clause dynamically
  const whereClauses: string[] = [
    'matched_operation_id IS NULL',
    "match_method IN ('awaiting_invoice','awaiting_marketplace_settlement')",
    'currency = ?',
    'direction = ?',
    'executed_at BETWEEN ? AND ?',
  ];
  const params: any[] = [op.currency, expectedDirection, dateMin, dateMax];

  if (useAmountFilter) {
    whereClauses.push('amount BETWEEN ? AND ?');
    params.push(amountMin, amountMax);
  }

  // Partner match: by INN if partner has tax_id, else by name substring
  if (op.partner_inn) {
    whereClauses.push('contragent_inn = ?');
    params.push(op.partner_inn);
  } else if (op.partner_trade || op.partner_legal) {
    const name = (op.partner_trade || op.partner_legal || '').slice(0, 20);
    whereClauses.push('(contragent_name LIKE ? OR payment_purpose LIKE ?)');
    params.push(`%${name}%`, `%${name}%`);
  } else {
    // No way to match partner → don't allocate
    return { attached_tx_ids: [], attached_count: 0, debug: debug ? { reason: 'no_partner_inn_or_name' } : undefined };
  }

  const sql = `SELECT id, amount, currency, contragent_inn, contragent_name,
            executed_at, payment_purpose, direction, external_doc_number
       FROM bank_transactions
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ABS(executed_at - ?) ASC
      LIMIT 10`;
  const allParams = [...params, op.operation_date];

  const candidatesRes = await env.DB.prepare(sql).bind(...allParams).all<BankTxRow>();

  const candidates = candidatesRes.results || [];
  if (candidates.length === 0) {
    return {
      attached_tx_ids: [],
      attached_count: 0,
      debug: debug ? { reason: 'no_candidates', sql, params: allParams, op } : undefined,
    };
  }

  // Attach each candidate. If multiple match, attach all (split payment).
  const now = Math.floor(Date.now() / 1000);
  const attachedIds: string[] = [];

  for (const tx of candidates) {
    const stmts: any[] = [];

    stmts.push(env.DB.prepare(
      `UPDATE bank_transactions
          SET matched_operation_id = ?,
              match_method = 'auto_allocated_on_op_create',
              matched_at = ?,
              matched_by = 'system',
              updated_at = ?
        WHERE id = ?`,
    ).bind(operationId, now, now, tx.id));

    const attId = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const txAmountMajor = tx.amount / minorFactor;
    stmts.push(env.DB.prepare(
      `INSERT INTO operation_attachments (
         id, operation_id, direction, kind,
         doc_number, doc_date, amount, currency, issuer,
         parsed_from, source_ref_id, notes,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, 'bank_tx', ?, ?, ?, ?)`,
    ).bind(
      attId, operationId, tx.direction,
      tx.external_doc_number || null,
      tx.executed_at,
      txAmountMajor,
      tx.currency,
      tx.contragent_name || 'bank',
      tx.id,
      `[auto-allocated on op-create] purpose: ${(tx.payment_purpose || '').slice(0, 300)}`,
      now, now,
    ));

    await env.DB.batch(stmts);
    attachedIds.push(tx.id);
  }

  return { attached_tx_ids: attachedIds, attached_count: attachedIds.length };
}
