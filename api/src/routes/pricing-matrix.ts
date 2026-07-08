import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import zones from '../pricing/zones.json';
import basePrices from '../pricing/base-prices.json';
import { priceCatalogue, type ZonesConfig } from '../pricing/resolver';
import { readPricingRates } from '../lib/fx-pricing';

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
  { country: 'AE', currency: 'AED' },
  { country: 'SA', currency: 'SAR' },
  { country: 'QA', currency: 'QAR' },
  { country: 'KW', currency: 'KWD' },
  { country: 'BH', currency: 'BHD' },
  { country: 'OM', currency: 'OMR' },
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

  const columns = COLUMNS.map((col) => {
    const cat = priceCatalogue(col.country, { cfg, rates, baseBySku });
    const rate = col.currency === cfg.base_currency ? 1 : rates[col.currency] ?? null;
    return {
      country: col.country,
      currency: col.currency,
      zone: cat.zone,
      decimals: cat.decimals,
      rate,
      stripe_hidden: cfg.stripe_hidden_zones.includes(cat.zone),
      prices: cat.prices, // { SKU: amount }
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

export default pricingMatrix;
