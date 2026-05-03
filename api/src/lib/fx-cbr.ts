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
//
// Storage precision:
//   rate_to_usd_nano = round(rate_to_usd * 10^9)
//
// CRITICAL — Currency minor_factor:
//   Most currencies have 100 minor units per major unit (USD/RUB/EUR/CNY have
//   cents/kopecks). VND, JPY, KRW have NO subdivision — minor_factor = 1.
//   Money amounts in this system are always stored in MINOR units of their
//   own currency. When converting between currencies with different
//   minor_factors, both factors must enter the formula:
//
//     amount_target_minor = (amount_source_minor × rate_to_usd_nano
//                            × target_minor_factor)
//                           / (NANO_FACTOR × source_minor_factor)
//
//   Without this, e.g. 10M VND (stored as 10_000_000) converted to USD
//   would yield 398 (i.e. $3.98) instead of 39826 cents ($398.26).
// =============================================================================

const CBR_CURRENT_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';
const CBR_ARCHIVE_URL_TEMPLATE = 'https://www.cbr-xml-daily.ru/archive/{YYYY}/{MM}/{DD}/daily_json.js';

const TARGET_CURRENCIES = ['USD', 'EUR', 'CNY', 'VND'] as const;
const NANO_FACTOR = 1_000_000_000;

// Currency minor unit factor: how many minor units in one major unit.
// 100 = has cents/kopecks (USD/RUB/EUR/CNY)
//   1 = no subdivision (VND/JPY/KRW)
// Default for unlisted currencies is 100.
const CURRENCY_MINOR_FACTOR: Record<string, number> = {
  USD: 100,
  RUB: 100,
  EUR: 100,
  CNY: 100,
  VND: 1,
  JPY: 1,
  KRW: 1,
};

const DEFAULT_MINOR_FACTOR = 100;

export function minorFactorFor(currency: string): number {
  return CURRENCY_MINOR_FACTOR[currency] ?? DEFAULT_MINOR_FACTOR;
}

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

// =============================================================================
// Apply FX rate to amount, accounting for asymmetric minor unit factors.
//
// Formula:
//   target_minor = (source_minor × rate_to_usd_nano × target_factor)
//                  / (NANO_FACTOR × source_factor)
//
// When source and target both have factor 100 (e.g. RUB→USD), factors cancel
// and this reduces to: source_minor × rate_to_usd_nano / NANO_FACTOR
//
// When source = VND (factor 1) and target = USD (factor 100), the explicit
// multiplication by target_factor=100 corrects what would otherwise be
// a 100× understated result.
// =============================================================================
export function applyFxToAmount(
  amountSourceMinor: number,
  rateToUsdNano: number,
  sourceCurrency: string,
  targetCurrency: string = 'USD'
): number {
  const sourceFactor = minorFactorFor(sourceCurrency);
  const targetFactor = minorFactorFor(targetCurrency);

  return Math.round(
    (amountSourceMinor * rateToUsdNano * targetFactor) /
    (NANO_FACTOR * sourceFactor)
  );
}
