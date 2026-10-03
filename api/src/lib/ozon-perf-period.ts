// Ozon Performance limits: 10 campaigns/report, one concurrent export/account.
// https://docs.ozon.ru/api/performance/#tag/Limits
export type SalesPeriod = { dateFrom: string; dateTo: string };

export function salesPeriod(rows: Array<{ period_from: string; period_to: string }>): SalesPeriod {
  const periods = new Set(rows.map(r => `${r.period_from}|${r.period_to}`));
  if (periods.size !== 1) throw new Error('Ozon sales snapshot has no single period');
  const [dateFrom, dateTo] = [...periods][0].split('|');
  const days = (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000 + 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)
      || !Number.isFinite(days) || days < 1 || days > 62) {
    throw new Error('Ozon sales period exceeds Performance export limits');
  }
  return { dateFrom, dateTo };
}

export function historicalCampaigns(rows: any[], period: SalesPeriod): string[] {
  const types = new Set(['SKU', 'SEARCH_PROMO', 'BRAND_SHELF', 'ACTION']);
  return [...new Set(rows.filter(c => types.has(c.advObjectType)
    // Current state says nothing about spending earlier in this window.
    && (!c.fromDate || String(c.fromDate).slice(0, 10) <= period.dateTo)
    && (!c.toDate || String(c.toDate).slice(0, 10) >= period.dateFrom))
    .map(c => String(c.id)).filter(id => /^\d+$/.test(id)))];
}

export function mergeCpc(previous: Record<string, number>, next: Map<string, number>): Record<string, number> {
  const result = { ...previous };
  for (const [sku, amount] of next) result[sku] = (result[sku] || 0) + amount;
  return result;
}

export function guardOzonCpc(row: any): any {
  const matched = Boolean(row.cpc_period_from && row.cpc_period_to
    && row.cpc_period_from === row.period_from && row.cpc_period_to === row.period_to);
  if (matched) return { ...row, cpc_period_matches_sales: true };
  // null means unknown, not free advertising. Preserve the raw figure as evidence.
  return { ...row, cpc_period_matches_sales: false, cost_per_click_unverified_rub: row.cost_per_click_rub,
    cost_per_click_rub: null, ad_spend_rub: null, expenses_total_rub: null };
}

// Ozon currently echoes local calendar boundaries as UTC timestamps (UTC+3).
export function echoedPeriodMatches(request: any, period: SalesPeriod): boolean {
  if (request?.dateFrom && request?.dateTo) {
    return request.dateFrom === period.dateFrom && request.dateTo === period.dateTo;
  }
  if (!request?.from || !request?.to) return false;
  return Date.parse(request.from) === Date.parse(period.dateFrom) - 3 * 3600000
    && Date.parse(request.to) === Date.parse(period.dateTo) + 21 * 3600000 - 1000;
}
