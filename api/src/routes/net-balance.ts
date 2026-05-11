// =============================================================================
// Net Balance — partner financial position in USD
//
// Logic:
//   Operations create debt obligations once they're confirmed:
//     - Sale issued/shipped/delivered:    they owe us total_amount  (+ for us)
//     - Purchase issued/shipped/delivered: we owe them total_amount (- for us)
//     - Other types (transfer/bundling):  ignored
//   Payments cancel debt:
//     - Incoming payment: a sale is being paid down → reduces what they owe (- for us)
//     - Outgoing payment: a purchase is being paid down → reduces what we owe (+ for us)
//   FX: today's CBR rate, USD pivot.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import { getRatesFor } from '../lib/fx-store';
import { getRateToUsdNano, applyFxToAmount, todayUtcDate } from '../lib/fx-cbr';

export interface OperationRow {
  contract_id: string;
  operation_type: string;
  total_amount: number;
  currency: string;
  status: string;
}

export interface PaymentRow {
  amount: number;
  currency: string;
  direction: string;
}

const DEBT_STATUSES = new Set(['issued', 'shipped', 'delivered']);

// Compute USD-pivoted net balance for a partner from raw rows + FX snapshot.
export function computeNetBalance(
  ops: OperationRow[],
  pays: PaymentRow[],
  snapshot: { rates: Record<string, { rate_to_usd_nano: number }> } | null
) {
  const byCurrency: Record<string, number> = {};

  for (const op of ops) {
    if (!DEBT_STATUSES.has(op.status)) continue;
    const sign = op.operation_type === 'sale'     ? 1 :
                 op.operation_type === 'purchase' ? -1 : 0;
    if (sign === 0) continue;
    byCurrency[op.currency] = (byCurrency[op.currency] ?? 0) + sign * op.total_amount;
  }

  for (const p of pays) {
    // Incoming payment: we received money — sale debt reduces (subtract from + side).
    // Outgoing payment: we sent money — purchase debt reduces (add to - side).
    const sign = p.direction === 'incoming' ? -1 : 1;
    byCurrency[p.currency] = (byCurrency[p.currency] ?? 0) + sign * p.amount;
  }

  let totalUsd = 0;
  const breakdown: Array<{ currency: string; balance: number; balance_usd: number }> = [];

  for (const [currency, balance] of Object.entries(byCurrency)) {
    if (currency === 'USD') {
      breakdown.push({ currency, balance, balance_usd: balance });
      totalUsd += balance;
      continue;
    }

    const rateToUsd = snapshot ? getRateToUsdNano(snapshot as never, currency) : null;
    if (rateToUsd === null) {
      breakdown.push({ currency, balance, balance_usd: 0 });
      continue;
    }

    const usd = applyFxToAmount(Math.abs(balance), rateToUsd, currency, 'USD');
    const signed = balance < 0 ? -usd : usd;
    breakdown.push({ currency, balance, balance_usd: signed });
    totalUsd += signed;
  }

  return { totalUsd, breakdown, byCurrency };
}


// =============================================================================
// Shared helper — load bulk balances for many partners in a single round-trip.
// Used by both /api/net-balance (bulk endpoint) and /api/partners?include=balance.
// =============================================================================
export interface BulkBalanceEntry {
  partner_id: string;
  net_balance_usd: number;
  currencies: Record<string, number>;
}

export async function loadBulkBalances(env: Env): Promise<{
  balances: BulkBalanceEntry[];
  fx_date: string | null;
}> {
  const partnersResult = await env.DB.prepare(
    'SELECT id FROM partners WHERE deleted_at IS NULL'
  ).all<{ id: string }>();

  const today = todayUtcDate();
  const snapshot = await getRatesFor(env.FX, today);

  const opsAggResult = await env.DB.prepare(`
    SELECT c.partner_id AS partner_id,
           o.operation_type AS operation_type,
           o.currency AS currency,
           o.status AS status,
           SUM(o.total_amount) AS total
    FROM operations o
    JOIN contracts c ON o.contract_id = c.id
    WHERE o.deleted_at IS NULL
      AND o.status IN ('issued','shipped','delivered')
    GROUP BY c.partner_id, o.operation_type, o.currency, o.status
  `).all<{
    partner_id: string;
    operation_type: string;
    currency: string;
    status: string;
    total: number;
  }>();

  const paysAggResult = await env.DB.prepare(`
    SELECT partner_id,
           currency,
           direction,
           SUM(amount) AS total
    FROM payments
    WHERE deleted_at IS NULL
    GROUP BY partner_id, currency, direction
  `).all<{
    partner_id: string;
    currency: string;
    direction: string;
    total: number;
  }>();

  const opsByPartner = new Map<string, OperationRow[]>();
  for (const r of opsAggResult.results) {
    if (!r.partner_id) continue;
    const list = opsByPartner.get(r.partner_id) ?? [];
    list.push({
      contract_id: '',
      operation_type: r.operation_type,
      total_amount: r.total,
      currency: r.currency,
      status: r.status,
    });
    opsByPartner.set(r.partner_id, list);
  }

  const paysByPartner = new Map<string, PaymentRow[]>();
  for (const r of paysAggResult.results) {
    if (!r.partner_id) continue;
    const list = paysByPartner.get(r.partner_id) ?? [];
    list.push({
      amount: r.total,
      currency: r.currency,
      direction: r.direction,
    });
    paysByPartner.set(r.partner_id, list);
  }

  const balances: BulkBalanceEntry[] = [];
  for (const p of partnersResult.results) {
    const ops = opsByPartner.get(p.id) ?? [];
    const pays = paysByPartner.get(p.id) ?? [];
    const { totalUsd, byCurrency } = computeNetBalance(ops, pays, snapshot);
    balances.push({
      partner_id: p.id,
      net_balance_usd: totalUsd,
      currencies: byCurrency,
    });
  }

  return { balances, fx_date: snapshot?.date ?? null };
}

// =============================================================================
// Per-partner — mounted at /api/partners → adds /:slug/net-balance
// =============================================================================
const netBalancePerPartner = new Hono<{ Bindings: Env }>();

netBalancePerPartner.get('/:slug/net-balance', async (c) => {
  const slug = c.req.param('slug');
  const today = todayUtcDate();
  const snapshot = await getRatesFor(c.env.FX, today);

  const opsResult = await c.env.DB.prepare(`
    SELECT o.contract_id, o.operation_type, o.total_amount, o.currency, o.status
    FROM operations o
    JOIN contracts c ON o.contract_id = c.id
    WHERE c.partner_id = ?
      AND o.deleted_at IS NULL
      AND o.status IN ('issued','shipped','delivered')
  `).bind(slug).all<OperationRow>();

  const paysResult = await c.env.DB.prepare(`
    SELECT amount, currency, direction
    FROM payments
    WHERE partner_id = ? AND deleted_at IS NULL
  `).bind(slug).all<PaymentRow>();

  const { totalUsd, breakdown } = computeNetBalance(
    opsResult.results,
    paysResult.results,
    snapshot
  );

  return ok(c, {
    partner_id: slug,
    currencies_breakdown: breakdown,
    net_balance_usd: totalUsd,
    fx_date: snapshot?.date ?? null,
    calculated_at: Math.floor(Date.now() / 1000),
  });
});

// =============================================================================
// Bulk — mounted at /api/net-balance → adds /
// =============================================================================
const netBalanceBulk = new Hono<{ Bindings: Env }>();

netBalanceBulk.get('/', async (c) => {
  const { balances, fx_date } = await loadBulkBalances(c.env);
  return ok(c, {
    count: balances.length,
    balances,
    fx_date,
  });
});

export { netBalancePerPartner, netBalanceBulk };

