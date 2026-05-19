// =============================================================================
// Marketplace payout → sales-report matcher  (v3 — Ozon period API + WB date)
//
// For OZON: bank purpose has invoice date "СЧ.№№:XXXXXXXX ОТ DD.MM.YY".
// Ozon settles WEEKLY but splits at month boundaries (so each weekly period
// lies fully within one calendar month). Invoice for a settlement period is
// issued on the next business day after period.end (typically Mon→Sun cycle).
//
// Truth source: GET /v1/finance/cash-flow-statement/list returns each weekly
// period with begin/end dates. We look up invoice_date − 1..4 days to find the
// matching period.end, then attribute the payment to that period's month.
//
// For WB: bank purpose has registry date "от DD.MM.YYYY" which IS the period
// boundary (Monday after Sun-end week). Plain date-based lookup works.
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

// Parse the LAST "от DD.MM.YY(YY)?" from payment_purpose. Returns unix sec UTC or null.
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

interface OzonPeriod {
  begin: string;            // YYYY-MM-DD
  end: string;              // YYYY-MM-DD
  month: string;            // period's own month (where end-date sits)
  predominant_month: string; // logical Mon-Sun week's dominant month (handles boundary splits)
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + 'T00:00:00Z').getTime();
  const b = new Date(bIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Group consecutive periods into "logical weeks" (capped at 7 days) and
// compute the predominant calendar month of each logical week. Handles
// Ozon's habit of splitting boundary weeks into two periods.
function annotatePeriodsWithPredominantMonth(periods: OzonPeriod[]): OzonPeriod[] {
  if (periods.length === 0) return periods;
  // Walk periods, accumulate into a logical week until 7 days or gap
  type Group = { members: OzonPeriod[]; dayCount: Record<string, number> };
  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const p of periods) {
    const periodDays = daysBetween(p.begin, p.end) + 1;
    // Count days per month for this period
    const localDays: Record<string, number> = {};
    for (let i = 0; i < periodDays; i++) {
      const day = addDaysIso(p.begin, i);
      const m = day.slice(0, 7);
      localDays[m] = (localDays[m] ?? 0) + 1;
    }

    if (!cur) {
      cur = { members: [p], dayCount: { ...localDays } };
      continue;
    }
    const last = cur.members[cur.members.length - 1];
    const isContiguous = addDaysIso(last.end, 1) === p.begin;
    const currentDays = Object.values(cur.dayCount).reduce((s, n) => s + n, 0);
    if (isContiguous && currentDays + periodDays <= 7) {
      cur.members.push(p);
      for (const [m, n] of Object.entries(localDays)) {
        cur.dayCount[m] = (cur.dayCount[m] ?? 0) + n;
      }
    } else {
      groups.push(cur);
      cur = { members: [p], dayCount: { ...localDays } };
    }
  }
  if (cur) groups.push(cur);

  // Assign predominant_month to every period in each group
  const annotated: OzonPeriod[] = [];
  for (const g of groups) {
    const entries = Object.entries(g.dayCount).sort((a, b) => b[1] - a[1]);
    const predominant = entries[0][0];
    for (const m of g.members) {
      annotated.push({ ...m, predominant_month: predominant });
    }
  }
  return annotated;
}

// Fetch Ozon cash-flow periods (with KV cache 6h) and annotate with predominant_month.
async function getOzonPeriods(env: Env): Promise<OzonPeriod[]> {
  const cacheKey = 'ozon:periods:logical:v2';
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  const fromIso = '2025-01-01T00:00:00.000Z';
  const toIso = '2027-12-31T23:59:59.000Z';
  const raw: OzonPeriod[] = [];

  for (let page = 1; page <= 5; page++) {
    const resp = await fetch('https://api-seller.ozon.ru/v1/finance/cash-flow-statement/list', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ date: { from: fromIso, to: toIso }, page, page_size: 100 }),
    });
    if (!resp.ok) { console.error(`[ozon cash-flow] page ${page} HTTP ${resp.status}`); break; }
    const data = await resp.json() as { result: { cash_flows: Array<{ period: { begin: string; end: string } }>; page_count: number } };
    const flows = data.result?.cash_flows ?? [];
    for (const f of flows) {
      const begin = f.period.begin.slice(0, 10);
      const end = f.period.end.slice(0, 10);
      raw.push({ begin, end, month: end.slice(0, 7), predominant_month: end.slice(0, 7) });
    }
    if (page >= (data.result?.page_count ?? 1)) break;
  }

  raw.sort((a, b) => a.end.localeCompare(b.end));
  const annotated = annotatePeriodsWithPredominantMonth(raw);
  await env.CACHE.put(cacheKey, JSON.stringify(annotated), { expirationTtl: 6 * 3600 });
  return annotated;
}

// Find settlement period.end ≤ invoice_date − 1 within last 5 days, return its
// PREDOMINANT month (which correctly handles boundary-week splits).
async function getOzonMonthForInvoiceDate(env: Env, invoiceDateSec: number): Promise<string | null> {
  const periods = await getOzonPeriods(env);
  const invDate = new Date(invoiceDateSec * 1000);
  for (let lag = 1; lag <= 5; lag++) {
    const target = new Date(invDate);
    target.setUTCDate(target.getUTCDate() - lag);
    const targetStr = target.toISOString().slice(0, 10);
    const hit = periods.find((p) => p.end === targetStr);
    if (hit) return hit.predominant_month;
  }
  return null;
}

interface ReportRow {
  id: string;
  contract_id: string;
  operation_date: number;
  reference: string | null;
}

// Find the partner's monthly report whose operation_date is the last day of `monthStr` (YYYY-MM).
async function findMonthlyReportByMonth(
  env: Env,
  partnerId: string,
  monthStr: string
): Promise<ReportRow | null> {
  // Compute first and last day of the month
  const [yy, mm] = monthStr.split('-').map((s) => parseInt(s, 10));
  const firstSec = Math.floor(Date.UTC(yy, mm - 1, 1) / 1000);
  const lastSec = Math.floor(Date.UTC(yy, mm, 0, 23, 59, 59) / 1000);
  const row = await env.DB.prepare(`
    SELECT id, contract_id, operation_date, reference
    FROM operations
    WHERE partner_id = ?
      AND operation_type = 'sale'
      AND status IN ('issued','delivered')
      AND deleted_at IS NULL
      AND operation_date >= ?
      AND operation_date <= ?
    ORDER BY operation_date DESC
    LIMIT 1
  `).bind(partnerId, firstSec, lastSec).first<ReportRow>();
  return row ?? null;
}

// WB-style date fallback (purpose_date or executed_at): last report ≤ target.
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
    | 'matched_by_ozon_period'
    | 'matched_by_wb_registry_date'
    | 'matched_by_wb_purpose_date'
    | 'matched_by_fallback_date'
    | 'no_report_in_window'
    | 'already_matched'
    | 'not_marketplace'
    | 'tx_not_found'
    | 'wrong_direction'
    | 'ozon_period_lookup_failed';
  operation_id?: string;
  payment_id?: string;
  purpose_date?: number;
  ozon_month?: string;
}

export async function tryMarketplaceMatchForTx(env: Env, txId: string): Promise<MatchTxResult> {
  const tx = await env.DB.prepare(`
    SELECT id, amount, currency, executed_at, contragent_inn, direction,
           matched_operation_id, deleted_at, payment_purpose
    FROM bank_transactions
    WHERE id = ?
  `).bind(txId).first<{
    id: string; amount: number; currency: string; executed_at: number;
    contragent_inn: string | null; direction: string;
    matched_operation_id: string | null; deleted_at: number | null;
    payment_purpose: string | null;
  }>();

  if (!tx || tx.deleted_at) return { matched: false, reason: 'tx_not_found' };
  if (tx.matched_operation_id) return { matched: false, reason: 'already_matched' };
  if (tx.direction !== 'incoming') return { matched: false, reason: 'wrong_direction' };

  const cfg = tx.contragent_inn ? MARKETPLACE_CONFIG[tx.contragent_inn] : undefined;
  if (!cfg) return { matched: false, reason: 'not_marketplace' };

  const purposeDate = extractPeriodDateFromPurpose(tx.payment_purpose);

  let report: ReportRow | null = null;
  let matchMethod: 'matched_by_ozon_period' | 'matched_by_wb_purpose_date' | 'matched_by_fallback_date' | null = null;
  let ozonMonth: string | null = null;

  if (cfg.partnerId === 'ozon' && purposeDate) {
    // Ozon: API lookup → period → month → report
    ozonMonth = await getOzonMonthForInvoiceDate(env, purposeDate);
    if (!ozonMonth) {
      return { matched: false, reason: 'ozon_period_lookup_failed', purpose_date: purposeDate };
    }
    report = await findMonthlyReportByMonth(env, 'ozon', ozonMonth);
    matchMethod = 'matched_by_ozon_period';
  } else if (cfg.partnerId === 'wb' && purposeDate) {
    // WB convention: registry create_dt = operation_date + 1 day (Mon after Sun-end week).
    // Bank purpose "от DD.MM.YYYY" IS the registry create_dt, so the matching
    // operation has operation_date = purposeDate - 86400.
    const expectedOpDate = purposeDate - 86400;
    report = await env.DB.prepare(`
      SELECT id, contract_id, operation_date, reference
      FROM operations
      WHERE partner_id = 'wb' AND operation_type = 'sale'
        AND status IN ('issued','delivered') AND deleted_at IS NULL
        AND operation_date = ?
      LIMIT 1
    `).bind(expectedOpDate).first<ReportRow>();
    if (report) {
      matchMethod = 'matched_by_wb_registry_date';
    } else {
      // Registry not in our DB (phantom week / missing report) — fall back to "last ≤"
      report = await findReportByDate(env, 'wb', purposeDate);
      matchMethod = report ? 'matched_by_wb_purpose_date' : null as any;
    }
  } else {
    // No purpose date — fall back to executed_at window
    report = await findReportByDate(env, cfg.partnerId, tx.executed_at);
    matchMethod = 'matched_by_fallback_date';
  }

  if (!report) return {
    matched: false,
    reason: 'no_report_in_window',
    purpose_date: purposeDate ?? undefined,
    ozon_month: ozonMonth ?? undefined,
  };

  const now = Math.floor(Date.now() / 1000);
  const paymentId = `pay_${crypto.randomUUID()}`;
  const amountMajor = tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount;

  const noteSrc = matchMethod === 'matched_by_ozon_period'
    ? `Ozon period (month=${ozonMonth})`
    : matchMethod === 'matched_by_wb_purpose_date'
    ? `WB purpose date ${new Date((purposeDate ?? 0) * 1000).toISOString().slice(0, 10)}`
    : `fallback executed_at`;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                            payment_date, type, direction, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)
    `).bind(
      paymentId, cfg.partnerId, report.contract_id, report.id,
      amountMajor, tx.currency, tx.executed_at,
      `[AUTO-MATCH marketplace v3 ${matchMethod}] bank_tx ${tx.id} → ${cfg.cadenceLabel} report ${report.reference ?? report.id} via ${noteSrc}`,
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
    ozon_month: ozonMonth ?? undefined,
  };
}

export interface RetroactiveScanResult {
  ran_at: number;
  scanned: number;
  matched_by_ozon_period: number;
  matched_by_wb_registry_date: number;
  matched_by_wb_purpose_date: number;
  matched_by_fallback: number;
  no_report_in_window: number;
  ozon_period_lookup_failed: number;
  errors: number;
  by_partner: Record<string, { matched: number; unmatched: number; errors: number }>;
}

export async function scanAllUnmatchedMarketplace(env: Env): Promise<RetroactiveScanResult> {
  const result: RetroactiveScanResult = {
    ran_at: Math.floor(Date.now() / 1000),
    scanned: 0,
    matched_by_ozon_period: 0,
    matched_by_wb_registry_date: 0,
    matched_by_wb_purpose_date: 0,
    matched_by_fallback: 0,
    no_report_in_window: 0,
    ozon_period_lookup_failed: 0,
    errors: 0,
    by_partner: {
      ozon: { matched: 0, unmatched: 0, errors: 0 },
      wb: { matched: 0, unmatched: 0, errors: 0 },
    },
  };

  for (const inn of Object.keys(MARKETPLACE_CONFIG)) {
    const cfg = MARKETPLACE_CONFIG[inn];
    const txns = await env.DB.prepare(`
      SELECT id FROM bank_transactions
      WHERE contragent_inn = ? AND direction = 'incoming'
        AND deleted_at IS NULL AND matched_operation_id IS NULL
      ORDER BY executed_at ASC
    `).bind(inn).all<{ id: string }>();

    for (const row of txns.results) {
      result.scanned++;
      try {
        const r = await tryMarketplaceMatchForTx(env, row.id);
        if (r.matched) {
          result.by_partner[cfg.partnerId].matched++;
          if (r.reason === 'matched_by_ozon_period') result.matched_by_ozon_period++;
          else if (r.reason === 'matched_by_wb_registry_date') result.matched_by_wb_registry_date++;
          else if (r.reason === 'matched_by_wb_purpose_date') result.matched_by_wb_purpose_date++;
          else if (r.reason === 'matched_by_fallback_date') result.matched_by_fallback++;
        } else if (r.reason === 'no_report_in_window') {
          result.no_report_in_window++;
          result.by_partner[cfg.partnerId].unmatched++;
        } else if (r.reason === 'ozon_period_lookup_failed') {
          result.ozon_period_lookup_failed++;
          result.by_partner[cfg.partnerId].unmatched++;
        }
      } catch (e) {
        result.errors++;
        result.by_partner[cfg.partnerId].errors++;
        console.error(`[marketplace-match v3] tx=${row.id} failed:`, e);
      }
    }
  }

  return result;
}
