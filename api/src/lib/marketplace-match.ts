// =============================================================================
// Marketplace payout → sales-report matcher.
//
// Bank-tx incoming from Ozon (INN 7704217370) and Wildberries (INN 9714053621)
// are NOT standalone sales — they're cash settlements of the marketplace's
// periodic sales report:
//   Ozon  → monthly report, dated last day of month. Payouts arrive over the
//           next 30-45 days.
//   WB    → weekly  report, dated last day of week.  Payouts arrive over the
//           next 7-14  days.
//
// This module finds the most recent closed report (status issued/delivered) of
// the same partner whose operation_date sits inside a lookback window before
// the bank-tx executed_at, and links the tx as a payment to that report.
//
// Idempotent — already-matched txns are skipped.
// =============================================================================

import type { Env } from '../types';

export interface MarketplaceConfig {
  partnerId: string;
  lookbackDays: number;
  cadenceLabel: 'monthly' | 'weekly';
}

export const MARKETPLACE_CONFIG: Record<string, MarketplaceConfig> = {
  '7704217370': { partnerId: 'ozon', lookbackDays: 45, cadenceLabel: 'monthly' },
  '9714053621': { partnerId: 'wb',   lookbackDays: 14, cadenceLabel: 'weekly'  },
};

export function isMarketplaceInn(inn: string | null | undefined): boolean {
  if (!inn) return false;
  return inn in MARKETPLACE_CONFIG;
}

interface ReportRow {
  id: string;
  contract_id: string;
  operation_date: number;
  reference: string | null;
}

// Find the most recent closed sale-report whose operation_date is within
// [bankTxDateSec - lookbackDays*86400, bankTxDateSec]. NULL if no report fits.
async function findEnclosingReport(
  env: Env,
  partnerId: string,
  bankTxDateSec: number,
  lookbackDays: number
): Promise<ReportRow | null> {
  const minDate = bankTxDateSec - lookbackDays * 86400;
  const row = await env.DB.prepare(`
    SELECT id, contract_id, operation_date, reference
    FROM operations
    WHERE partner_id = ?
      AND operation_type = 'sale'
      AND status IN ('issued','delivered')
      AND deleted_at IS NULL
      AND operation_date <= ?
      AND operation_date >= ?
    ORDER BY operation_date DESC
    LIMIT 1
  `).bind(partnerId, bankTxDateSec, minDate).first<ReportRow>();
  return row ?? null;
}

export interface MatchTxResult {
  matched: boolean;
  reason: 'matched' | 'no_report_in_window' | 'already_matched' | 'not_marketplace' | 'tx_not_found' | 'wrong_direction';
  operation_id?: string;
  payment_id?: string;
}

// Match a single bank_tx (by id). Returns reason so caller can branch.
// Safe to call repeatedly — checks current state every time.
export async function tryMarketplaceMatchForTx(
  env: Env,
  txId: string
): Promise<MatchTxResult> {
  const tx = await env.DB.prepare(`
    SELECT id, amount, currency, executed_at, contragent_inn, direction,
           matched_operation_id, deleted_at
    FROM bank_transactions
    WHERE id = ?
  `).bind(txId).first<{
    id: string;
    amount: number;
    currency: string;
    executed_at: number;
    contragent_inn: string | null;
    direction: string;
    matched_operation_id: string | null;
    deleted_at: number | null;
  }>();

  if (!tx || tx.deleted_at) return { matched: false, reason: 'tx_not_found' };
  if (tx.matched_operation_id) return { matched: false, reason: 'already_matched' };
  if (tx.direction !== 'in') return { matched: false, reason: 'wrong_direction' };

  const cfg = tx.contragent_inn ? MARKETPLACE_CONFIG[tx.contragent_inn] : undefined;
  if (!cfg) return { matched: false, reason: 'not_marketplace' };

  const report = await findEnclosingReport(env, cfg.partnerId, tx.executed_at, cfg.lookbackDays);
  if (!report) return { matched: false, reason: 'no_report_in_window' };

  const now = Math.floor(Date.now() / 1000);
  const paymentId = `pay_${crypto.randomUUID()}`;
  // bank_tx.amount is in minor units (kopeks for RUB) — payments.amount is decimal major.
  const amountMajor = tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                            payment_date, type, direction, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)
    `).bind(
      paymentId, cfg.partnerId, report.contract_id, report.id,
      amountMajor, tx.currency, tx.executed_at,
      `[AUTO-MATCH marketplace-report] bank_tx ${tx.id} → ${cfg.cadenceLabel} report ${report.reference ?? report.id} (${cfg.lookbackDays}d window)`,
      now, now
    ),
    env.DB.prepare(`
      UPDATE bank_transactions
      SET matched_operation_id = ?, matched_payment_id = ?, matched_at = ?,
          match_method = 'marketplace_report_window', matched_by = 'system_auto',
          updated_at = ?
      WHERE id = ?
    `).bind(report.id, paymentId, now, now, tx.id),
  ]);

  return {
    matched: true,
    reason: 'matched',
    operation_id: report.id,
    payment_id: paymentId,
  };
}

export interface RetroactiveScanResult {
  ran_at: number;
  scanned: number;
  matched: number;
  no_report_in_window: number;
  errors: number;
  by_partner: Record<string, { matched: number; unmatched: number; errors: number }>;
  details_unmatched: Array<{ tx_id: string; partner: string; date: number; reason: string }>;
}

// Scan every unmatched IN bank_tx from Ozon/WB INNs and try to attach.
export async function scanAllUnmatchedMarketplace(env: Env): Promise<RetroactiveScanResult> {
  const result: RetroactiveScanResult = {
    ran_at: Math.floor(Date.now() / 1000),
    scanned: 0,
    matched: 0,
    no_report_in_window: 0,
    errors: 0,
    by_partner: {
      ozon: { matched: 0, unmatched: 0, errors: 0 },
      wb: { matched: 0, unmatched: 0, errors: 0 },
    },
    details_unmatched: [],
  };

  for (const inn of Object.keys(MARKETPLACE_CONFIG)) {
    const cfg = MARKETPLACE_CONFIG[inn];
    const txns = await env.DB.prepare(`
      SELECT id
      FROM bank_transactions
      WHERE contragent_inn = ?
        AND direction = 'in'
        AND deleted_at IS NULL
        AND matched_operation_id IS NULL
      ORDER BY executed_at ASC
    `).bind(inn).all<{ id: string }>();

    for (const row of txns.results) {
      result.scanned++;
      try {
        const r = await tryMarketplaceMatchForTx(env, row.id);
        if (r.matched) {
          result.matched++;
          result.by_partner[cfg.partnerId].matched++;
        } else if (r.reason === 'no_report_in_window') {
          result.no_report_in_window++;
          result.by_partner[cfg.partnerId].unmatched++;
          const detail = await env.DB.prepare(
            'SELECT executed_at FROM bank_transactions WHERE id = ?'
          ).bind(row.id).first<{ executed_at: number }>();
          result.details_unmatched.push({
            tx_id: row.id, partner: cfg.partnerId,
            date: detail?.executed_at ?? 0, reason: 'no_report_in_window',
          });
        }
      } catch (e) {
        result.errors++;
        result.by_partner[cfg.partnerId].errors++;
        console.error(`[marketplace-match] tx=${row.id} failed:`, e);
      }
    }
  }

  return result;
}
