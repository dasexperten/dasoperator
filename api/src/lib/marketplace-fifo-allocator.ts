// ============================================================================
// marketplace-fifo-allocator.ts
// ----------------------------------------------------------------------------
// FIFO allocation of bank_transactions to marketplace sale operations.
//
// Triggered by:
//   • cron (nightly sweep)
//   • POST /api/operations/_sweep-marketplace-allocator (manual)
//   • marketplace-pull pipeline after creating a new monthly/weekly op
//
// Algorithm:
//   1. Resolve sender INN to a partner via fixed alias map.
//      Aliases: ozon_credit → ozon (Ozon MKK pays for Ozon sales).
//   2. For each partner, list ALL parked incoming bank_tx
//      (status awaiting_marketplace_settlement OR awaiting_invoice, ordered by date asc).
//   3. For each partner, list ALL sale ops (operation_type='sale') for that partner
//      with total_amount > 0, ordered by operation_date asc — oldest first (FIFO).
//      Compute each op's unpaid_remainder = total_amount − sum(attached payments).
//   4. Walk through bank_txs chronologically. For each tx, walk through ops
//      in order until tx amount is consumed:
//        - if tx.amount ≤ first_op.unpaid_remainder → attach full tx to op,
//          op.remainder decreases, tx done.
//        - if tx.amount > first_op.unpaid_remainder → attach partial tx to op
//          (split), op closed; carry remainder into next op.
//   5. If tx amount remains after all ops are filled → leave it parked
//      (awaiting_marketplace_settlement preserved, partial allocation recorded).
//
// Data model: each (tx, op) link is one operation_attachments row
//   kind='payment', source_ref_id=tx.id, amount=allocated_portion.
// Bank tx itself stays linked to the LAST op it touched (for inbox UI display).
// ============================================================================

import type { Env } from '../types';

// Partner alias map: bank tx INN → canonical partner_id used for sale ops.
// Extend here when new legal entities appear (e.g. wb_credit, ozon_bank).
const PARTNER_ALIASES: Record<string, string> = {
  // 7704217370 → ozon already maps via partners.tax_id directly
  // 9714053621 → wb already maps via partners.tax_id directly
  // 9705212635 → яндекс_пей_продажи_с_нашего_сайта already maps directly
  '9703026898': 'ozon', // OZON MKK Credit pays for Ozon sales
  '7802754982': 'ozon', // Sberbank Factoring — pays for ИНН 7704217370 (Ozon) via factoring
  '7702045051': 'ozon', // MTS-Bank — pays for contract ИР-34138/22 (Ozon factoring)
};

// Currency minor factor: RUB/USD/CNY = 100, VND/JPY/KRW = 1
const NO_SUBDIVISION = new Set(['VND', 'JPY', 'KRW']);

interface ParkedTx {
  id: string;
  amount: number;       // MINOR units
  currency: string;
  executed_at: number;
  direction: string;
  payment_purpose: string | null;
  contragent_name: string | null;
  external_doc_number: string | null;
  match_method: string | null;
}

interface SaleOp {
  id: string;
  reference: string;
  total_amount: number; // MAJOR (decimal)
  currency: string;
  operation_date: number;
  partner_id: string;
  unpaid_remainder: number; // MAJOR, computed
}

export interface MarketplaceAllocatorResult {
  partner_id: string;
  payments_processed: number;
  allocations_created: number;
  ops_fully_closed: string[];
  ops_partially_paid: string[];
  leftover_amount_major: number; // RUB amount that couldn't be allocated (no more ops)
}

// Name-based aliases: when bank tx has NULL INN but recognizable contragent_name,
// route to a canonical partner_id. Used for foreign payment processors that
// route payments through their own legal entity name without an INN.
const PARTNER_NAME_ALIASES: Record<string, string> = {
  'NETWORK INTERNATIONAL LLC': 'dasexperten_com', // Stripe via Wio → dasexperten.com online sales
};

const SUPPORTED_PARTNERS = [
  'ozon',
  'wb',
  'яндекс_пей_продажи_с_нашего_сайта',
  'dasexperten_com',
];

/**
 * Run FIFO allocator for a single partner.
 */
export async function runMarketplaceFifoForPartner(
  env: Env,
  partnerId: string,
): Promise<MarketplaceAllocatorResult> {
  // Build INN list: partner's own tax_id + any aliases pointing here
  const partner = await env.DB.prepare(
    `SELECT id, tax_id, currency FROM partners WHERE id = ? AND deleted_at IS NULL`,
  ).bind(partnerId).first<{ id: string; tax_id: string; currency: string | null }>();

  if (!partner || !partner.tax_id) {
    return {
      partner_id: partnerId,
      payments_processed: 0,
      allocations_created: 0,
      ops_fully_closed: [],
      ops_partially_paid: [],
      leftover_amount_major: 0,
    };
  }

  // Collect INNs and names that should route here
  const aliasInns = Object.entries(PARTNER_ALIASES)
    .filter(([, target]) => target === partnerId)
    .map(([inn]) => inn);
  const allInns = [partner.tax_id, ...aliasInns];
  const aliasNames = Object.entries(PARTNER_NAME_ALIASES)
    .filter(([, target]) => target === partnerId)
    .map(([name]) => name);

  // Default currency for ops (assume same as partner's primary)
  // We allocate per-currency; for now RUB is the only marketplace currency,
  // but the query enforces tx.currency == op.currency anyway.
  const currency = partner.currency || 'RUB';
  const minorFactor = NO_SUBDIVISION.has(currency) ? 1 : 100;

  // Pull parked bank_txs (oldest first)
  // Match by INN OR by recognized contragent_name (for INN-less payment processors)
  const innList = allInns.map(() => '?').join(',');
  let nameClause = '';
  const params: any[] = [...allInns];
  if (aliasNames.length > 0) {
    const nameList = aliasNames.map(() => '?').join(',');
    nameClause = `OR (contragent_inn IS NULL AND contragent_name IN (${nameList}))`;
    params.push(...aliasNames);
  }
  params.push(currency);

  const txRes = await env.DB.prepare(
    `SELECT id, amount, currency, executed_at, direction, payment_purpose,
            contragent_name, external_doc_number, match_method
       FROM bank_transactions
      WHERE matched_operation_id IS NULL
        AND match_method IN ('awaiting_marketplace_settlement', 'awaiting_invoice', 'awaiting_site_sales_settlement')
        AND direction = 'incoming'
        AND (contragent_inn IN (${innList}) ${nameClause})
        AND currency = ?
      ORDER BY executed_at ASC`,
  ).bind(...params).all<ParkedTx>();

  const parkedTxs = txRes.results || [];
  if (parkedTxs.length === 0) {
    return {
      partner_id: partnerId,
      payments_processed: 0,
      allocations_created: 0,
      ops_fully_closed: [],
      ops_partially_paid: [],
      leftover_amount_major: 0,
    };
  }

  // Pull sale ops with total > 0, oldest first
  const opsRes = await env.DB.prepare(
    `SELECT id, reference, total_amount, currency, operation_date
       FROM operations
      WHERE partner_id = ?
        AND operation_type = 'sale'
        AND deleted_at IS NULL
        AND status IN ('issued','shipped','delivered')
        AND total_amount > 0
        AND currency = ?
      ORDER BY operation_date ASC`,
  ).bind(partnerId, currency).all<{
    id: string; reference: string; total_amount: number;
    currency: string; operation_date: number;
  }>();

  // For each op, compute already-attached payment sum and unpaid_remainder
  const ops: SaleOp[] = [];
  for (const op of (opsRes.results || [])) {
    const paidRes = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS paid
         FROM operation_attachments
        WHERE operation_id = ?
          AND kind = 'payment'
          AND currency = ?`,
    ).bind(op.id, op.currency).first<{ paid: number }>();
    const paid = Number(paidRes?.paid || 0);
    const remainder = Math.max(0, op.total_amount - paid);
    if (remainder > 0.01) { // ignore essentially-paid ops
      ops.push({
        id: op.id,
        reference: op.reference,
        total_amount: op.total_amount,
        currency: op.currency,
        operation_date: op.operation_date,
        partner_id: partnerId,
        unpaid_remainder: remainder,
      });
    }
  }

  if (ops.length === 0) {
    // All ops fully paid, can't allocate
    const totalLeftover = parkedTxs.reduce((s, t) => s + t.amount, 0) / minorFactor;
    return {
      partner_id: partnerId,
      payments_processed: 0,
      allocations_created: 0,
      ops_fully_closed: [],
      ops_partially_paid: [],
      leftover_amount_major: totalLeftover,
    };
  }

  // FIFO walk: each tx tries to fill the oldest unpaid op
  let opCursor = 0;
  let allocations = 0;
  let txsProcessed = 0;
  const fullyClosed: string[] = [];
  const partiallyPaid = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  let leftoverMinor = 0;

  for (const tx of parkedTxs) {
    let txRemaining = tx.amount / minorFactor; // major
    txsProcessed++;
    let lastTouchedOpId: string | null = null;

    while (txRemaining > 0.01 && opCursor < ops.length) {
      const op = ops[opCursor];
      const allocateAmount = Math.min(txRemaining, op.unpaid_remainder);

      // Record attachment
      const attId = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await env.DB.prepare(
        `INSERT INTO operation_attachments (
           id, operation_id, direction, kind,
           doc_number, doc_date, amount, currency, issuer,
           parsed_from, source_ref_id, notes,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, 'bank_tx', ?, ?, ?, ?)`,
      ).bind(
        attId, op.id, tx.direction, tx.external_doc_number || null,
        tx.executed_at, allocateAmount, op.currency,
        tx.contragent_name || 'marketplace',
        tx.id,
        `[FIFO marketplace alloc] ${allocateAmount} of ${tx.amount / minorFactor} ${op.currency} from tx ${tx.id} → ${op.reference}. purpose: ${(tx.payment_purpose || '').slice(0, 200)}`,
        now, now,
      ).run();

      allocations++;
      lastTouchedOpId = op.id;
      op.unpaid_remainder -= allocateAmount;
      txRemaining -= allocateAmount;

      if (op.unpaid_remainder < 0.01) {
        fullyClosed.push(op.reference);
        opCursor++;
      } else {
        partiallyPaid.add(op.reference);
      }
    }

    // Update bank_tx with last touched op + status
    if (lastTouchedOpId) {
      // tx fully consumed → linked to its last op, status = auto_allocated_marketplace_fifo
      const status = txRemaining < 0.01
        ? 'auto_allocated_marketplace_fifo'
        : 'partially_allocated_marketplace_fifo'; // leftover dust
      await env.DB.prepare(
        `UPDATE bank_transactions
            SET matched_operation_id = ?,
                match_method = ?,
                matched_at = ?,
                matched_by = 'system_fifo',
                updated_at = ?
          WHERE id = ?`,
      ).bind(lastTouchedOpId, status, now, now, tx.id).run();
    } else {
      // Could not allocate any portion — ops exhausted
      leftoverMinor += tx.amount;
    }

    if (opCursor >= ops.length && txRemaining > 0.01) {
      // No more ops to fill — count leftover
      leftoverMinor += txRemaining * minorFactor;
    }
  }

  return {
    partner_id: partnerId,
    payments_processed: txsProcessed,
    allocations_created: allocations,
    ops_fully_closed: fullyClosed,
    ops_partially_paid: Array.from(partiallyPaid),
    leftover_amount_major: leftoverMinor / minorFactor,
  };
}

/**
 * Run FIFO allocator for all supported marketplace partners.
 */
export async function runMarketplaceFifoAll(
  env: Env,
): Promise<MarketplaceAllocatorResult[]> {
  const results: MarketplaceAllocatorResult[] = [];
  for (const partnerId of SUPPORTED_PARTNERS) {
    const r = await runMarketplaceFifoForPartner(env, partnerId);
    results.push(r);
  }
  return results;
}
