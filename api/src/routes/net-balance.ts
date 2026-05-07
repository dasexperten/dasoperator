// =============================================================================
// Net Balance — partner financial position in USD
//
// Logic (Phase 3.0e Q5/Q7/Q8/Q14):
//   - Sale operation (delivered/shipped):    they owe us total_amount  (+ for us)
//   - Purchase operation (delivered/shipped): we owe them total_amount (- for us)
//   - Service/Transfer operations:           ignored for net balance
//   - Payment incoming:                      cancels their debt        (- for us)
//   - Payment outgoing:                      cancels our debt          (+ for us)
//   - Status filter (Q5):                    only delivered/shipped count
//   - FX (Q14):                              today's CBR rate, USD pivot
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import { getRatesFor } from '../lib/fx-store';
import { getRateToUsdNano, applyFxToAmount, todayUtcDate } from '../lib/fx-cbr';

interface OperationRow {
  contract_id: string;
  operation_type: string;
  total_amount: number;
  currency: string;
  status: string;
}

interface PaymentRow {
  amount: number;
  currency: string;
  direction: string;
}

// Compute USD-pivoted net balance for a partner from raw rows + FX snapshot.
function computeNetBalance(
  ops: OperationRow[],
  pays: PaymentRow[],
  snapshot: { rates: Record<string, { rate_to_usd_nano: number }> } | null
) {
  const byCurrency: Record<string, number> = {};

  for (const op of ops) {
    const sign = op.operation_type === 'sale'     ? 1 :
                 op.operation_type === 'purchase' ? -1 : 0;
    if (sign === 0) continue;
    byCurrency[op.currency] = (byCurrency[op.currency] ?? 0) + sign * op.total_amount;
  }

  for (const p of pays) {
    // payment cancels debt: incoming reduces what they owe (negative for us in their column);
    // outgoing reduces what we owe (positive in their column from our perspective)
    const sign = p.direction === 'incoming' ? -1 : 1;
    byCurrency[p.currency] = (byCurrency[p.currency] ?? 0) + sign * p.amount;
  }

  let totalUsdCents = 0;
  const breakdown: Array<{ currency: string; balance: number; balance_usd: number }> = [];

  for (const [currency, balanceMinor] of Object.entries(byCurrency)) {
    if (currency === 'USD') {
      breakdown.push({ currency, balance: balanceMinor, balance_usd: balanceMinor });
      totalUsdCents += balanceMinor;
      continue;
    }

    const rateToUsd = snapshot ? getRateToUsdNano(snapshot as never, currency) : null;
    if (rateToUsd === null) {
      breakdown.push({ currency, balance: balanceMinor, balance_usd: 0 });
      continue;
    }

    const usdCents = applyFxToAmount(Math.abs(balanceMinor), rateToUsd, currency, 'USD');
    const signed = balanceMinor < 0 ? -usdCents : usdCents;
    breakdown.push({ currency, balance: balanceMinor, balance_usd: signed });
    totalUsdCents += signed;
  }

  return { totalUsdCents, breakdown, byCurrency };
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
      AND o.status IN ('delivered','shipped')
  `).bind(slug).all<OperationRow>();

  const paysResult = await c.env.DB.prepare(`
    SELECT amount, currency, direction
    FROM payments
    WHERE partner_id = ? AND deleted_at IS NULL
  `).bind(slug).all<PaymentRow>();

  const { totalUsdCents, breakdown } = computeNetBalance(
    opsResult.results,
    paysResult.results,
    snapshot
  );

  return ok(c, {
    partner_id: slug,
    currencies_breakdown: breakdown,
    net_balance_usd: totalUsdCents,
    fx_date: snapshot?.date ?? null,
    calculated_at: Math.floor(Date.now() / 1000),
  });
});

// =============================================================================
// Bulk — mounted at /api/net-balance → adds /
// =============================================================================
const netBalanceBulk = new Hono<{ Bindings: Env }>();

netBalanceBulk.get('/', async (c) => {
  const partnersResult = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE deleted_at IS NULL'
  ).all<{ id: string }>();

  const today = todayUtcDate();
  const snapshot = await getRatesFor(c.env.FX, today);
  const balances: Array<{
    partner_id: string;
    net_balance_usd: number;
    currencies: Record<string, number>;
  }> = [];

  for (const p of partnersResult.results) {
    const opsResult = await c.env.DB.prepare(`
      SELECT o.operation_type, o.total_amount, o.currency, o.status, o.contract_id
      FROM operations o
      JOIN contracts c ON o.contract_id = c.id
      WHERE c.partner_id = ? AND o.deleted_at IS NULL AND o.status IN ('delivered','shipped')
    `).bind(p.id).all<OperationRow>();

    const paysResult = await c.env.DB.prepare(`
      SELECT amount, currency, direction FROM payments
      WHERE partner_id = ? AND deleted_at IS NULL
    `).bind(p.id).all<PaymentRow>();

    const { totalUsdCents, byCurrency } = computeNetBalance(
      opsResult.results,
      paysResult.results,
      snapshot
    );

    balances.push({
      partner_id: p.id,
      net_balance_usd: totalUsdCents,
      currencies: byCurrency,
    });
  }

  return ok(c, {
    count: balances.length,
    balances,
    fx_date: snapshot?.date ?? null,
  });
});

export { netBalancePerPartner, netBalanceBulk };
