// =============================================================================
// /api/marketplace/match — marketplace payout → sales-report linker.
//
// POST /api/marketplace/match
//   Walks every unmatched IN bank_tx from Ozon / WB INN and attaches it to the
//   most recent closed sale-report of the same partner. Idempotent.
//
// POST /api/marketplace/match/:txId
//   Single-tx version — useful for retry on one row.
//
// GET /api/marketplace/match/dry-run
//   Read-only — lists candidate matches without writing.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  scanAllUnmatchedMarketplace,
  tryMarketplaceMatchForTx,
  MARKETPLACE_CONFIG,
} from '../lib/marketplace-match';

const marketplaceMatch = new Hono<{ Bindings: Env }>();

// Sweep all unmatched bank_tx from Ozon/WB INNs
marketplaceMatch.post('/match', async (c) => {
  const result = await scanAllUnmatchedMarketplace(c.env);
  return ok(c, result);
});

// Re-run match for one specific bank_tx
marketplaceMatch.post('/match/:txId', async (c) => {
  const txId = c.req.param('txId');
  const r = await tryMarketplaceMatchForTx(c.env, txId);
  if (!r.matched && r.reason === 'tx_not_found') {
    return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
  }
  return ok(c, r);
});

// Dry-run — what WOULD match, without writing anything.
marketplaceMatch.get('/match/dry-run', async (c) => {
  const out: Array<{
    tx_id: string;
    tx_date: number;
    amount: number;
    currency: string;
    contragent_inn: string;
    target_partner: string;
    candidate_report_id: string | null;
    candidate_report_ref: string | null;
    candidate_report_date: number | null;
    decision: 'would_match' | 'no_report_in_window';
  }> = [];

  for (const inn of Object.keys(MARKETPLACE_CONFIG)) {
    const cfg = MARKETPLACE_CONFIG[inn];
    const txns = await c.env.DB.prepare(`
      SELECT id, amount, currency, executed_at
      FROM bank_transactions
      WHERE contragent_inn = ?
        AND direction = 'in'
        AND deleted_at IS NULL
        AND matched_operation_id IS NULL
      ORDER BY executed_at ASC
    `).bind(inn).all<{ id: string; amount: number; currency: string; executed_at: number }>();

    for (const tx of txns.results) {
      const minDate = tx.executed_at - cfg.lookbackDays * 86400;
      const report = await c.env.DB.prepare(`
        SELECT id, reference, operation_date
        FROM operations
        WHERE partner_id = ? AND operation_type = 'sale' AND status IN ('issued','delivered')
          AND deleted_at IS NULL AND operation_date <= ? AND operation_date >= ?
        ORDER BY operation_date DESC LIMIT 1
      `).bind(cfg.partnerId, tx.executed_at, minDate).first<{ id: string; reference: string | null; operation_date: number }>();

      out.push({
        tx_id: tx.id,
        tx_date: tx.executed_at,
        amount: tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount,
        currency: tx.currency,
        contragent_inn: inn,
        target_partner: cfg.partnerId,
        candidate_report_id: report?.id ?? null,
        candidate_report_ref: report?.reference ?? null,
        candidate_report_date: report?.operation_date ?? null,
        decision: report ? 'would_match' : 'no_report_in_window',
      });
    }
  }

  return ok(c, {
    total: out.length,
    would_match: out.filter((x) => x.decision === 'would_match').length,
    no_report: out.filter((x) => x.decision === 'no_report_in_window').length,
    rows: out,
  });
});

export default marketplaceMatch;
