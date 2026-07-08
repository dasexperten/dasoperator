import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import zones from '../pricing/zones.json';
import basePrices from '../pricing/base-prices.json';
import { priceCatalogue, type ZonesConfig } from '../pricing/resolver';
import { readPricingRates } from '../lib/fx-pricing';
import { readOverrides, setOverride } from '../lib/pricing-overrides';
import { fail } from '../lib/responses';

// =============================================================================
// GET /api/pricing/matrix — zonal pricing matrix for the ERP CRM view.
//
// The Phase-1 view of what the storefront charges by geography: every
// presented currency x every priced SKU, computed EUR base x daily FX x
// psychological rounding through the SAME resolver the storefront uses. This is
// the read model that the /crm "Матрица цен" section renders. (Phase 2 will make
// the matrix editable — a manual zone x SKU override table — behind the same
// resolver interface.)
// =============================================================================

const cfg = zones as unknown as ZonesConfig;
const baseBySku = (basePrices as { prices: Record<string, string> }).prices;

// Ordered showcase columns — one representative country per presented currency.
const COLUMNS: Array<{ country: string; currency: string }> = [
  { country: 'DE', currency: 'EUR' },
  { country: 'US', currency: 'USD' },
  { country: 'PL', currency: 'PLN' },
  { country: 'TR', currency: 'TRY' },
  { country: 'CA', currency: 'CAD' },
  { country: 'AE', currency: 'AED' },   // all Gulf countries -> AED
  { country: 'RU', currency: 'RUB' },
  { country: 'VN', currency: 'VND' },
  { country: 'TH', currency: 'THB' },
  { country: 'MY', currency: 'MYR' },
  { country: 'PH', currency: 'PHP' },
  { country: 'SG', currency: 'SGD' },
  { country: 'CN', currency: 'CNY' },
];

const pricingMatrix = new Hono<{ Bindings: Env }>();

pricingMatrix.get('/matrix', async (c) => {
  const { rates, updated_at } = await readPricingRates(c.env);
  const overrides = await readOverrides(c.env);

  const columns = COLUMNS.map((col) => {
    const cat = priceCatalogue(col.country, { cfg, rates, baseBySku, overrides });
    const rate = col.currency === cfg.base_currency ? 1 : rates[col.currency] ?? null;
    return {
      country: col.country,
      currency: col.currency,
      zone: cat.zone,
      decimals: cat.decimals,
      rate,
      stripe_hidden: cfg.stripe_hidden_zones.includes(cat.zone),
      prices: cat.prices,     // { SKU: amount }
      manual: cat.manual || {}, // { SKU: true } for hand-set cells
    };
  });

  const rows = Object.keys(baseBySku).map((sku) => ({ sku, base_eur: baseBySku[sku] }));

  // ERP view — always fresh; never let the edge cache this (or a transient 404).
  c.header('Cache-Control', 'no-store');
  return ok(c, {
    base_currency: cfg.base_currency,
    updated_at,
    rates_stale: !updated_at,
    columns,
    rows,
    zones: Object.keys(cfg.zones),
  });
});

// POST /api/pricing/override — set or clear a manual (currency, sku) price.
// Body: { currency, sku, amount }  (amount null/0/"" clears the override).
pricingMatrix.post('/override', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { return fail(c, 400, [{ code: 'bad_json', message: 'Body must be JSON' }]); }
  const currency = String(body.currency || '').toUpperCase();
  const sku = String(body.sku || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !sku) return fail(c, 422, [{ code: 'bad_input', message: 'currency (ISO) + sku required' }]);
  // Only allow currencies we actually present.
  if (cfg.currency_decimals[currency] == null) return fail(c, 422, [{ code: 'bad_currency', message: 'unknown currency ' + currency }]);
  let amount: number | null = null;
  if (body.amount != null && body.amount !== '') {
    amount = Number(body.amount);
    if (!(amount > 0)) return fail(c, 422, [{ code: 'bad_amount', message: 'amount must be > 0 or empty to clear' }]);
    amount = +amount.toFixed(cfg.currency_decimals[currency] ?? 2);
  }
  const overrides = await setOverride(c.env, currency, sku, amount);
  c.header('Cache-Control', 'no-store');
  return ok(c, { currency, sku, amount, cleared: amount == null, overrides });
});

// POST /api/pricing/sync-ozon — pull current Ozon prices → RUB overrides now.
// (Also runs on a cron; this endpoint lets the ERP trigger it on demand.)
pricingMatrix.post('/sync-ozon', async (c) => {
  const { syncOzonPricesToRub } = await import('../lib/ozon-price-sync');
  const r = await syncOzonPricesToRub(c.env);
  c.header('Cache-Control', 'no-store');
  return ok(c, r);
});

export default pricingMatrix;
