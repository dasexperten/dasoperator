// =============================================================================
// Marketplace payout → sales-report matcher  (v2 — purpose-date parsing)
//
// Ozon / Wildberries pay out CASH for a specific report period. The report
// total is GROSS REVENUE (sales); the payout is NET CASH (sales − commission
// − ads − returns − holdbacks). The two will never equal — but each payout
// belongs to exactly one report period, identified by the date in the bank
// payment_purpose field:
//
//   Ozon WBE/IR contract:
//     'Оплата за тов. по дог. ИР-34138/22 от 12.02.2022 согл.сч.№№:39817264 от 20.04.26'
//     Last "от DD.MM.YY" = invoice date → covers prior month's report.
//
//   WB contract:
//     'Оплата по договору б/н от 04.05.2026 за товар. Сумма ...'
//     The "от DD.MM.YYYY" = registry date → covers the Sunday week-end ≤ that date.
//
// The rule for both: find the partner's most recent closed sale-report whose
// operation_date ≤ purpose_date (within 60 days). If no purpose date can be
// parsed, fall back to executed_at as the target date.
// =============================================================================

import type { Env } from '../types';

export interface MarketplaceConfig {
  partnerId: string;
  cadenceLabel: 'monthly' | 'weekly';
}

export const MARKETPLACE_CONFIG: Record<string, MarketplaceConfig> = {
  '7704217370': { partnerId: 'ozon', cadenceLabel: 'monthly' },
  '9714053621': { partnerId: 'wb',   cadenceLabel: 'weekly'  },
};

export function isMarketplaceInn(inn: string | null | undefined): boolean {
  if (!inn) return false;
  return inn in MARKETPLACE_CONFIG;
}

// =============================================================================
// Parse the LAST "от DD.MM.YY(YY)?" occurrence from a payment_purpose string.
// Both Ozon and WB include this; Ozon includes TWO (contract date + invoice
// date) so we take the last one which is the invoice date.
// Returns a unix timestamp (seconds, UTC) or null.
// =============================================================================
export function extractPeriodDateFromPurpose(purpose: string | null | undefined): number | null {
  if (!purpose) return null;
  const matches = [...purpose.matchAll(/от\s+(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (!last[1] || !last[2] || !last[3]) return null;
  const day = parseInt(last[1], 10);
  const month = parseInt(last[2], 10);
  let year = parseInt(last[3], 10);
  if (year < 100) year += 2000;
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2020 || year > 2050) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

interface ReportRow {
  id: string;
  contract_id: string;
  operation_date: number;
  reference: string | null;
}

// Find the partner's most recent closed sale-report whose operation_date ≤ target.
// Lookback is 60 days — enough for any Ozon monthly cycle (≤ 31 days) and any
// WB weekly cycle with delayed payouts (≤ 14 days). Beyond that, we don't try.
async function findReportByDate(
  env: Env,
  partnerId: string,
  targetDateSec: number,
  lookbackDays = 60
): Promise<ReportRow | null> {
  const minDate = targetDateSec - lookbackDays * 86400;
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
  `).bind(partnerId, targetDateSec, minDate).first<ReportRow>();
  return row ?? null;
}

export interface MatchTxResult {
  matched: boolean;
  reason:
    | 'matched_by_purpose_date'
    | 'matched_by_fallback_date'
    | 'no_report_in_window'
    | 'already_matched'
    | 'not_marketplace'
    | 'tx_not_found'
    | 'wrong_direction';
  operation_id?: string;
  payment_id?: string;
  purpose_date?: number;
}

export async function tryMarketplaceMatchForTx(
  env: Env,
  txId: string
): Promise<MatchTxResult> {
  const tx = await env.DB.prepare(`
    SELECT id, amount, currency, executed_at, contragent_inn, direction,
           matched_operation_id, deleted_at, payment_purpose
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
    payment_purpose: string | null;
  }>();

  if (!tx || tx.deleted_at) return { matched: false, reason: 'tx_not_found' };
  if (tx.matched_operation_id) return { matched: false, reason: 'already_matched' };
  if (tx.direction !== 'incoming') return { matched: false, reason: 'wrong_direction' };

  const cfg = tx.contragent_inn ? MARKETPLACE_CONFIG[tx.contragent_inn] : undefined;
  if (!cfg) return { matched: false, reason: 'not_marketplace' };

  // Try purpose-date first; fall back to executed_at.
  const purposeDate = extractPeriodDateFromPurpose(tx.payment_purpose);
  const targetDate = purposeDate ?? tx.executed_at;

  const report = await findReportByDate(env, cfg.partnerId, targetDate);
  if (!report) return {
    matched: false,
    reason: 'no_report_in_window',
    purpose_date: purposeDate ?? undefined,
  };

  const now = Math.floor(Date.now() / 1000);
  const paymentId = `pay_${crypto.randomUUID()}`;
  const amountMajor = tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount;
  const matchMethod = purposeDate ? 'matched_by_purpose_date' : 'matched_by_fallback_date';

  const noteSrc = purposeDate
    ? `purpose-date ${new Date(purposeDate * 1000).toISOString().slice(0, 10)}`
    : `fallback executed_at`;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                            payment_date, type, direction, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)
    `).bind(
      paymentId, cfg.partnerId, report.contract_id, report.id,
      amountMajor, tx.currency, tx.executed_at,
      `[AUTO-MATCH marketplace v2 ${matchMethod}] bank_tx ${tx.id} → ${cfg.cadenceLabel} report ${report.reference ?? report.id} via ${noteSrc}`,
      now, now
    ),
    env.DB.prepare(`
      UPDATE bank_transactions
      SET matched_operation_id = ?, matched_payment_id = ?, matched_at = ?,
          match_method = ?, matched_by = 'system_auto', updated_at = ?
      WHERE id = ?
    `).bind(report.id, paymentId, now, `marketplace_${matchMethod}`, now, tx.id),
  ]);

  return {
    matched: true,
    reason: matchMethod,
    operation_id: report.id,
    payment_id: paymentId,
    purpose_date: purposeDate ?? undefined,
  };
}

export interface RetroactiveScanResult {
  ran_at: number;
  scanned: number;
  matched_by_purpose: number;
  matched_by_fallback: number;
  no_report_in_window: number;
  errors: number;
  by_partner: Record<string, { matched: number; unmatched: number; errors: number }>;
}

export async function scanAllUnmatchedMarketplace(env: Env): Promise<RetroactiveScanResult> {
  const result: RetroactiveScanResult = {
    ran_at: Math.floor(Date.now() / 1000),
    scanned: 0,
    matched_by_purpose: 0,
    matched_by_fallback: 0,
    no_report_in_window: 0,
    errors: 0,
    by_partner: {
      ozon: { matched: 0, unmatched: 0, errors: 0 },
      wb: { matched: 0, unmatched: 0, errors: 0 },
    },
  };

  for (const inn of Object.keys(MARKETPLACE_CONFIG)) {
    const cfg = MARKETPLACE_CONFIG[inn];
    const txns = await env.DB.prepare(`
      SELECT id
      FROM bank_transactions
      WHERE contragent_inn = ?
        AND direction = 'incoming'
        AND deleted_at IS NULL
        AND matched_operation_id IS NULL
      ORDER BY executed_at ASC
    `).bind(inn).all<{ id: string }>();

    for (const row of txns.results) {
      result.scanned++;
      try {
        const r = await tryMarketplaceMatchForTx(env, row.id);
        if (r.matched) {
          result.by_partner[cfg.partnerId].matched++;
          if (r.reason === 'matched_by_purpose_date') result.matched_by_purpose++;
          else if (r.reason === 'matched_by_fallback_date') result.matched_by_fallback++;
        } else if (r.reason === 'no_report_in_window') {
          result.no_report_in_window++;
          result.by_partner[cfg.partnerId].unmatched++;
        }
      } catch (e) {
        result.errors++;
        result.by_partner[cfg.partnerId].errors++;
        console.error(`[marketplace-match v2] tx=${row.id} failed:`, e);
      }
    }
  }

  return result;
}
