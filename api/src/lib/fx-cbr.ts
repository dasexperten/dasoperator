// =============================================================================
// CBR exchange rate fetcher and cross-rate calculator
//
// CBR feed quirks:
//   - Anchored on RUB (Value = N RUB per (Nominal) units of currency)
//   - VND has Nominal=10000, NOT 1 — must divide by Nominal
//   - Other currencies (USD/EUR/CNY) have Nominal=1 typically but we always
//     normalize via Value/Nominal regardless
//
// Cross-rate to USD:
//   rate_to_usd = (Value / Nominal) / (USD.Value / USD.Nominal)
//   Example: EUR/USD = (88.64/1) / (74.80/1) = 1.185
//   Example: VND/USD = (29.79/10000) / (74.80/1) = 0.0000398
//
// Storage precision:
//   rate_to_usd_nano = round(rate_to_usd * 10^9)
//   This gives ~9 significant digits, sufficient for VND (~4 × 10^4 per USD)
//
// LIMITATION (Phase 2.0c-2c TODO):
//   applyFxToAmount assumes both source and target use the same minor-unit
//   factor (×100 for RUB/USD/EUR/CNY). For currencies without subdivision
//   (VND, JPY, KRW), the result is off by the minor-unit factor. Either
//   normalize VND amounts as vnd × 100 in operations, or pass minor_factor
//   into applyFxToAmount. Tracked separately.
// =============================================================================

const CBR_CURRENT_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const CBR_ARCHIVE_URL_TEMPLATE = 'https://www.cbr-xml-daily.ru/archive/{YYYY}/{MM}/{DD}/daily_json.js';

const TARGET_CURRENCIES = ['USD', 'EUR', 'CNY', 'VND'] as const;
const NANO_FACTOR = 1_000_000_000;

interface CbrValute {
  ID: string;
  NumCode: string;
  CharCode: string;
  Nominal: number;
  Name: string;
  Value: number;
  Previous: number;
}

interface CbrFeed {
  Date: string;
  PreviousDate: string;
  Timestamp: string;
  Valute: Record<string, CbrValute>;
}

export interface FxRate {
  rate_to_usd_nano: number;
}

export interface FxSnapshot {
  date: string;
  source: 'CBR';
  fetched_at: number;
  rates: Record<string, FxRate>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildCbrUrl(date: string, todayUtc: string): string {
  if (date === todayUtc) return CBR_CURRENT_URL;
  const [yyyy, mm, dd] = date.split('-');
  return CBR_ARCHIVE_URL_TEMPLATE
    .replace('{YYYY}', yyyy!)
    .replace('{MM}', mm!)
    .replace('{DD}', dd!);
}

export function todayUtcDate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export async function fetchCbrFeed(date: string): Promise<CbrFeed | null> {
  const todayUtc = todayUtcDate();
  const url = buildCbrUrl(date, todayUtc);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  try {
    return await response.json() as CbrFeed;
  } catch {
    return null;
  }
}

export function parseCbrToSnapshot(feed: CbrFeed, requestedDate: string): FxSnapshot | null {
  const valutes = feed.Valute;
  if (!valutes) return null;

  const usd = valutes.USD;
  if (!usd || !usd.Value || !usd.Nominal) return null;

  const usdRubPerUnit = usd.Value / usd.Nominal;

  const rates: Record<string, FxRate> = {
    USD: { rate_to_usd_nano: NANO_FACTOR },
    RUB: { rate_to_usd_nano: Math.round((1 / usdRubPerUnit) * NANO_FACTOR) },
  };

  for (const code of TARGET_CURRENCIES) {
    if (code === 'USD') continue;
    const v = valutes[code];
    if (!v || !v.Value || !v.Nominal) continue;
    const ccyRubPerUnit = v.Value / v.Nominal;
    const rateToUsd = ccyRubPerUnit / usdRubPerUnit;
    rates[code] = { rate_to_usd_nano: Math.round(rateToUsd * NANO_FACTOR) };
  }

  return {
    date: requestedDate,
    source: 'CBR',
    fetched_at: Math.floor(Date.now() / 1000),
    rates,
  };
}

export async function refreshFxFromCbr(date: string): Promise<FxSnapshot | null> {
  const feed = await fetchCbrFeed(date);
  if (!feed) return null;
  return parseCbrToSnapshot(feed, date);
}

export function getRateToUsdNano(snapshot: FxSnapshot, currency: string): number | null {
  const rate = snapshot.rates[currency];
  return rate ? rate.rate_to_usd_nano : null;
}

export function applyFxToAmount(
  amountMinor: number,
  rateToUsdNano: number
): number {
  return Math.round((amountMinor * rateToUsdNano) / NANO_FACTOR);
}
