// =============================================================================
// Storefront pricing FX rates (EUR-based) — SEPARATE from the ERP CBR store.
//
// The existing fx-cbr/fx-store keys (fx:{date}, fx:latest) are USD-anchored and
// cover only USD/EUR/CNY/VND — used by invoicing. Zonal storefront pricing needs
// 18 EUR-based currencies incl. Gulf pegs + RUB + VND, so it lives under its own
// keys and does not touch the CBR store:
//
//   fx:pricing:rates       → JSON { "USD": 1.14, "AED": 4.19, ... } (1 EUR = X)
//   fx:pricing:updated_at  → ISO timestamp string
//
// Primary source: open.er-api.com (free, no key, EUR base, covers all 18).
// Fallback: frankfurter.dev (ECB) for the majors it carries + fixed USD pegs for
// the Gulf currencies ECB does not publish. RUB/VND have no fallback (kept from
// the last good snapshot if both sources fail).
// =============================================================================

import type { Env } from '../types';
import zones from '../pricing/zones.json';

export const PRICING_RATES_KEY = 'fx:pricing:rates';
export const PRICING_UPDATED_KEY = 'fx:pricing:updated_at';

// Currencies the storefront actually presents (derived from zones config).
const NEEDED = Array.from(
  new Set([
    zones.base_currency,
    ...Object.values(zones.zone_default_currency),
    ...Object.values(zones.country_currency),
  ])
).filter((c) => c && c !== zones.base_currency);

// USD-peg fallbacks for currencies ECB/frankfurter does not publish.
// (KWD is basket-pegged and floats slightly — this is an approximation used only
//  if the live source is unavailable; the live source is normally authoritative.)
const USD_PEG: Record<string, number> = {
  AED: 3.6725,
  SAR: 3.75,
  QAR: 3.64,
  OMR: 0.3845,
  BHD: 0.376,
  KWD: 0.307,
};

interface RefreshResult {
  ok: boolean;
  source: string;
  count: number;
  missing: string[];
  updated_at: string;
}

async function fetchOpenErApi(): Promise<Record<string, number> | null> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/EUR', {
      cf: { cacheTtl: 300 },
    } as RequestInit);
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: string; rates?: Record<string, number> };
    if (j.result !== 'success' || !j.rates) return null;
    return j.rates;
  } catch {
    return null;
  }
}

async function fetchFrankfurter(): Promise<Record<string, number> | null> {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR');
    if (!r.ok) return null;
    const j = (await r.json()) as { rates?: Record<string, number> };
    return j.rates || null;
  } catch {
    return null;
  }
}

function pick(all: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of NEEDED) {
    const v = all[c] ?? 0;
    if (v > 0) out[c] = +v.toFixed(6);
  }
  return out;
}

// Fill Gulf pegs (and any still-missing needed currency covered by USD_PEG)
// from the EUR→USD rate: 1 EUR = usd USD, 1 USD = peg X  ⇒  1 EUR = usd*peg X.
function fillPegs(rates: Record<string, number>): void {
  const usd = rates.USD ?? 0;
  if (!(usd > 0)) return;
  for (const c of Object.keys(USD_PEG)) {
    const peg = USD_PEG[c] ?? 0;
    if (peg > 0 && !((rates[c] ?? 0) > 0)) rates[c] = +(usd * peg).toFixed(6);
  }
}

export async function refreshPricingRates(env: Env): Promise<RefreshResult> {
  let source = 'open.er-api';
  let all = await fetchOpenErApi();

  if (!all) {
    source = 'frankfurter+pegs';
    all = await fetchFrankfurter();
  }

  const updated_at = new Date().toISOString();

  if (!all) {
    // Both sources down — keep the last good snapshot, just record the attempt.
    const missing = NEEDED.slice();
    console.error('[fx-pricing] both sources unreachable; snapshot kept');
    return { ok: false, source: 'none', count: 0, missing, updated_at };
  }

  const rates = pick(all);
  fillPegs(rates);

  const missing = NEEDED.filter((c) => !((rates[c] ?? 0) > 0));
  if (missing.length) console.warn('[fx-pricing] missing rates:', missing.join(','));

  await env.FX.put(PRICING_RATES_KEY, JSON.stringify(rates));
  await env.FX.put(PRICING_UPDATED_KEY, updated_at);

  return { ok: true, source, count: Object.keys(rates).length, missing, updated_at };
}

// Read path for the /geo-price endpoint.
export async function readPricingRates(
  env: Env
): Promise<{ rates: Record<string, number>; updated_at: string | null }> {
  const [raw, updated_at] = await Promise.all([
    env.FX.get(PRICING_RATES_KEY),
    env.FX.get(PRICING_UPDATED_KEY),
  ]);
  let rates: Record<string, number> = {};
  if (raw) {
    try {
      rates = JSON.parse(raw) as Record<string, number>;
    } catch {
      rates = {};
    }
  }
  return { rates, updated_at };
}
