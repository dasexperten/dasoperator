// =============================================================================
// Zonal pricing resolver (Worker / TS port).
//
// Faithful port of dasexperten.com/site/com/pricing/resolver.js — keep in sync.
// The config (zones.json) is the shared SSOT; this file is pure logic. Turns an
// EUR base price into a zonal { amount, currency } via daily FX + psychological
// rounding. Deterministic, so this server-side result matches the storefront.
// =============================================================================

export interface ZonesConfig {
  version: number;
  base_currency: string;
  zones: Record<string, { anchor: string; label: string; stripe_hidden?: boolean }>;
  zone_default_currency: Record<string, string>;
  country_zone: Record<string, string>;
  country_currency: Record<string, string>;
  currency_rounding: Record<string, string>;
  currency_decimals: Record<string, number>;
  stripe_hidden_zones: string[];
  fallback_currency: string;
  banner_locale_home_zone: Record<string, string>;
  banner_locales: string[];
}

export type Rates = Record<string, number>; // EUR-based: 1 EUR = rates[X] X

export function zoneForCountry(cfg: ZonesConfig, country?: string): string {
  return (country && cfg.country_zone[country.toUpperCase()]) || 'ROW';
}

export function currencyForCountry(cfg: ZonesConfig, country?: string): string {
  const c = (country || '').toUpperCase();
  return (
    cfg.country_currency[c] ||
    cfg.zone_default_currency[zoneForCountry(cfg, c)] ||
    cfg.fallback_currency
  );
}

// --- psychological rounding (charm prices) ---
function end_90(x: number): number {
  const k = Math.max(0, Math.round(x - 0.9));
  return +(k + 0.9).toFixed(2);
}
function end_9_int(x: number): number {
  const n = Math.round(x / 10) * 10 - 1;
  return n < 9 ? 9 : n;
}
function end_9000(x: number): number {
  const n = Math.round(x / 10000) * 10000 - 1000;
  return n < 9000 ? 9000 : n;
}
function end_900_3dec(x: number): number {
  const k = Math.max(0, Math.round(x - 0.9));
  return +(k + 0.9).toFixed(3);
}
function end_90_rub(x: number): number {
  const n = Math.round(x / 100) * 100 - 10;
  return n < 90 ? 90 : n;
}

const ROUNDERS: Record<string, (x: number) => number> = {
  end_90,
  end_9_int,
  end_9000,
  end_900_3dec,
  end_90_rub,
};

export function roundFor(cfg: ZonesConfig, currency: string, amount: number): number {
  const rule = cfg.currency_rounding[currency];
  const fn = rule ? ROUNDERS[rule] : undefined;
  return fn ? fn(amount) : +amount.toFixed(2);
}

export function convert(
  cfg: ZonesConfig,
  baseEur: string | number,
  currency: string,
  rates: Rates
): number | null {
  const eur = typeof baseEur === 'string' ? parseFloat(baseEur) : baseEur;
  if (!(eur > 0)) return null;
  // EU-zone anchor: the EUR base IS the canonical charm price — never re-round.
  if (currency === cfg.base_currency) return +eur.toFixed(2);
  const rate = rates[currency] ?? 0;
  if (!(rate > 0)) return null;
  return roundFor(cfg, currency, eur * rate);
}

// Manual per-(currency, sku) price overrides (Phase 2 — editable in the ERP).
// A present value is the FINAL price in that currency: no FX, no rounding.
export type Overrides = Record<string, Record<string, number>>;

export interface ResolveCtx {
  cfg: ZonesConfig;
  rates: Rates;
  baseBySku: Record<string, string | number>;
  overrides?: Overrides;   // EFFECTIVE price overrides (auto + manual merged, manual wins)
  locked?: Overrides;      // MANUAL-only layer — drives the "locked" flag (never auto-synced)
}

export function overrideFor(overrides: Overrides | undefined, currency: string, sku: string): number | null {
  const cur = overrides && overrides[currency];
  const v = cur ? cur[sku] : undefined;
  return typeof v === 'number' && v > 0 ? v : null;
}

export interface PricedCatalogue {
  country: string;
  zone: string;
  currency: string;
  decimals: number;
  prices: Record<string, number>;
  manual?: Record<string, boolean>;
}

export function priceCatalogue(country: string | undefined, ctx: ResolveCtx): PricedCatalogue {
  const currency = currencyForCountry(ctx.cfg, country);
  const decimals = ctx.cfg.currency_decimals[currency] ?? 2;
  const prices: Record<string, number> = {};
  const manual: Record<string, boolean> = {};
  for (const sku of Object.keys(ctx.baseBySku)) {
    // "locked" reflects only a manual (hand-set) override for this cell.
    if (overrideFor(ctx.locked, currency, sku) != null) manual[sku] = true;
    const ov = overrideFor(ctx.overrides, currency, sku);
    if (ov != null) { prices[sku] = ov; continue; }
    const base = ctx.baseBySku[sku];
    if (base == null || base === '') continue;
    const amount = convert(ctx.cfg, base, currency, ctx.rates);
    if (amount != null) prices[sku] = amount;
  }
  return {
    country: (country || '').toUpperCase(),
    zone: zoneForCountry(ctx.cfg, country),
    currency,
    decimals,
    prices,
    manual,
  };
}

// Single-SKU authoritative price (used by checkout repricing in Phase 3).
export function priceForSku(
  sku: string,
  country: string | undefined,
  ctx: ResolveCtx
): { sku: string; amount: number; currency: string; zone: string } | null {
  const currency = currencyForCountry(ctx.cfg, country);
  const ov = overrideFor(ctx.overrides, currency, sku);
  if (ov != null) return { sku, amount: ov, currency, zone: zoneForCountry(ctx.cfg, country) };
  const base = ctx.baseBySku[sku];
  if (base == null || base === '') return null;
  const amount = convert(ctx.cfg, base, currency, ctx.rates);
  if (amount == null) return null;
  return { sku, amount, currency, zone: zoneForCountry(ctx.cfg, country) };
}
