// =============================================================================
// /api/marketplace/match — marketplace payout → sales-report linker  (v2)
// Uses payment_purpose date parsing as PRIMARY signal, falls back to
// executed_at if purpose has no parsable date.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  scanAllUnmatchedMarketplace,
  tryMarketplaceMatchForTx,
  extractPeriodDateFromPurpose,
  MARKETPLACE_CONFIG,
} from '../lib/marketplace-match';

const marketplaceMatch = new Hono<{ Bindings: Env }>();

marketplaceMatch.post('/match', async (c) => {
  const result = await scanAllUnmatchedMarketplace(c.env);
  return ok(c, result);
});

marketplaceMatch.post('/match/:txId', async (c) => {
  const txId = c.req.param('txId');
  const r = await tryMarketplaceMatchForTx(c.env, txId);
  if (!r.matched && r.reason === 'tx_not_found') {
    return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
  }
  return ok(c, r);
});

// Dry-run — show what WOULD match, using purpose-date logic.
marketplaceMatch.get('/match/dry-run', async (c) => {
  const out: Array<{
    tx_id: string;
    tx_date: number;
    amount: number;
    currency: string;
    contragent_inn: string;
    target_partner: string;
    purpose_date: number | null;
    purpose_snippet: string;
    candidate_report_id: string | null;
    candidate_report_ref: string | null;
    candidate_report_date: number | null;
    decision: 'would_match_by_purpose' | 'would_match_by_fallback' | 'no_report_in_window';
  }> = [];

  for (const inn of Object.keys(MARKETPLACE_CONFIG)) {
    const cfg = MARKETPLACE_CONFIG[inn];
    const txns = await c.env.DB.prepare(`
      SELECT id, amount, currency, executed_at, payment_purpose
      FROM bank_transactions
      WHERE contragent_inn = ?
        AND direction = 'incoming'
        AND deleted_at IS NULL
        AND matched_operation_id IS NULL
      ORDER BY executed_at ASC
    `).bind(inn).all<{
      id: string; amount: number; currency: string; executed_at: number; payment_purpose: string | null;
    }>();

    for (const tx of txns.results) {
      const purposeDate = extractPeriodDateFromPurpose(tx.payment_purpose);
      const targetDate = purposeDate ?? tx.executed_at;
      const minDate = targetDate - 60 * 86400;
      const report = await c.env.DB.prepare(`
        SELECT id, reference, operation_date
        FROM operations
        WHERE partner_id = ? AND operation_type = 'sale' AND status IN ('issued','delivered')
          AND deleted_at IS NULL AND operation_date <= ? AND operation_date >= ?
        ORDER BY operation_date DESC LIMIT 1
      `).bind(cfg.partnerId, targetDate, minDate).first<{
        id: string; reference: string | null; operation_date: number;
      }>();

      let decision: 'would_match_by_purpose' | 'would_match_by_fallback' | 'no_report_in_window';
      if (!report) decision = 'no_report_in_window';
      else if (purposeDate) decision = 'would_match_by_purpose';
      else decision = 'would_match_by_fallback';

      out.push({
        tx_id: tx.id,
        tx_date: tx.executed_at,
        amount: tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount,
        currency: tx.currency,
        contragent_inn: inn,
        target_partner: cfg.partnerId,
        purpose_date: purposeDate,
        purpose_snippet: (tx.payment_purpose ?? '').slice(0, 100),
        candidate_report_id: report?.id ?? null,
        candidate_report_ref: report?.reference ?? null,
        candidate_report_date: report?.operation_date ?? null,
        decision,
      });
    }
  }

  return ok(c, {
    total: out.length,
    would_match_by_purpose: out.filter((x) => x.decision === 'would_match_by_purpose').length,
    would_match_by_fallback: out.filter((x) => x.decision === 'would_match_by_fallback').length,
    no_report: out.filter((x) => x.decision === 'no_report_in_window').length,
    rows: out,
  });
});

export default marketplaceMatch;
