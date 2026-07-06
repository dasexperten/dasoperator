// =============================================================================
// Yandex Direct Reports API v5 client (TSV reports)
//
// POST https://api.direct.yandex.com/json/v5/reports
// Headers: Authorization: Bearer <DIRECT_OAUTH_TOKEN>, Accept-Language: ru,
//          processingMode: auto, returnMoneyInMicros: false
//
// HARD RULE: DIRECT_OAUTH_TOKEN is the only missing credential in the
// analytics stack. When it is absent every caller gets a graceful
// { configured: false } — never fabricated data, never a fake token
// (same skip pattern as cronCreatePerfReport).
//
// Reports API is asynchronous-capable: HTTP 200 = report in the body (TSV),
// HTTP 201/202 = report queued offline — callers surface { pending: true }
// and retry later (the nightly cron just tries again next night).
// =============================================================================

import type { Env } from '../types';

const DIRECT_REPORTS_URL = 'https://api.direct.yandex.com/json/v5/reports';

export function directConfigured(env: Env): boolean {
  return Boolean(env.DIRECT_OAUTH_TOKEN);
}

export interface DirectCampaignRow {
  campaign_id: string;
  campaign: string;
  impressions: number;
  clicks: number;
  cost: number; // currency units (returnMoneyInMicros=false), VAT included
  conversions: number;
}

export type DirectReportResult =
  | { status: 'ok'; rows: DirectCampaignRow[] }
  | { status: 'pending'; retry_in_sec: number }
  | { status: 'error'; message: string };

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Campaign performance for a date window. TSV, header + summary skipped, so
// every line is a data row: CampaignId, CampaignName, Impressions, Clicks,
// Cost, Conversions ("--" when the metric is undefined for the row).
// -----------------------------------------------------------------------------
export async function fetchDirectCampaigns(
  env: Env,
  dateFrom: string,
  dateTo: string
): Promise<DirectReportResult> {
  if (!env.DIRECT_OAUTH_TOKEN) {
    return { status: 'error', message: 'DIRECT_OAUTH_TOKEN not configured' };
  }

  const body = {
    params: {
      SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
      FieldNames: ['CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
      ReportName: `dasoperator-campaigns-${dateFrom}-${dateTo}`,
      ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
    },
  };

  const res = await fetch(DIRECT_REPORTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DIRECT_OAUTH_TOKEN}`,
      'Accept-Language': 'ru',
      'Content-Type': 'application/json; charset=utf-8',
      processingMode: 'auto',
      returnMoneyInMicros: 'false',
      skipReportHeader: 'true',
      skipReportSummary: 'true',
    },
    body: JSON.stringify(body),
  });

  // 201 = report queued, 202 = still building — retry later, don't cache
  if (res.status === 201 || res.status === 202) {
    const retryIn = parseInt(res.headers.get('retryIn') ?? '60', 10) || 60;
    return { status: 'pending', retry_in_sec: retryIn };
  }

  if (!res.ok) {
    return { status: 'error', message: `Direct Reports HTTP ${res.status}: ${await res.text()}` };
  }

  const tsv = await res.text();
  const rows: DirectCampaignRow[] = [];
  for (const line of tsv.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const cols = t.split('\t');
    if (cols.length < 6) continue;
    // "--" = undefined metric in Direct TSV
    const col = (i: number) => cols[i] ?? '';
    const n = (s: string) => {
      const v = parseFloat(s === '--' ? '0' : s.replace(',', '.'));
      return Number.isFinite(v) ? v : 0;
    };
    rows.push({
      campaign_id: col(0),
      campaign: col(1),
      impressions: n(col(2)),
      clicks: n(col(3)),
      cost: n(col(4)),
      conversions: n(col(5)),
    });
  }
  return { status: 'ok', rows };
}

export function directWindow(days: number): { dateFrom: string; dateTo: string } {
  return { dateFrom: isoDaysAgo(days), dateTo: isoDaysAgo(1) };
}
