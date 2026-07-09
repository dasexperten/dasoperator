import { Hono } from 'hono';
import type { Env } from '../types';
import zones from '../pricing/zones.json';
import basePrices from '../pricing/base-prices.json';
import { priceCatalogue, type ZonesConfig } from '../pricing/resolver';
import { readPricingRates, refreshPricingRates } from '../lib/fx-pricing';
import { readEffective } from '../lib/pricing-overrides';

// =============================================================================
// GET /geo-price — public zonal price feed for the storefront.
//
// Resolves the visitor's country (?country= for tests/ERP > CF-IPCountry),
// then returns { country, zone, currency, decimals, updated_at, prices }, where
// prices = { SKU: amount } computed EUR base x daily FX x psychological rounding.
//
// Location is by IP only — no cookie override (a stale one must not pin currency).
// Public (no auth, no credentials). Own permissive CORS for the two .com
// storefront origins. NOT shared-cacheable: the price varies by caller IP, which
// isn't in the URL. Display only — the charge is repriced server-side at checkout.
// =============================================================================

const cfg = zones as unknown as ZonesConfig;
const baseBySku = (basePrices as { prices: Record<string, string> }).prices;

const DEFAULT_ORIGIN = 'https://www.dasexperten.com';
const STORE_ORIGINS = [DEFAULT_ORIGIN, 'https://dasexperten.com'];

function corsFor(origin: string | undefined): Record<string, string> {
  const allow = origin && STORE_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

const ISO2 = /^[A-Za-z]{2}$/;

const geoPrice = new Hono<{ Bindings: Env }>();

geoPrice.options('/', (c) => new Response(null, { status: 204, headers: corsFor(c.req.header('Origin')) }));

geoPrice.get('/', async (c) => {
  const cors = corsFor(c.req.header('Origin'));

  // Resolution order: ?country= (manual test / ERP matrix) wins, then IP geo.
  // The dx_region cookie is intentionally NOT consulted — location is by IP only.
  // (A stale cookie must never pin a visitor to the wrong currency after a move.)
  const qCountry = c.req.query('country');
  const ipCountry = c.req.header('CF-IPCountry');
  let country = qCountry || ipCountry || '';
  if (!ISO2.test(country)) country = 'US'; // ROW anchor when unknown (T1 = Tor/unknown)
  country = country.toUpperCase();

  let { rates, updated_at } = await readPricingRates(c.env);

  // Cold start (KV not yet populated by the daily cron): populate on first miss
  // so the endpoint is usable immediately after deploy, not only after 12:00 UTC.
  if (!updated_at || Object.keys(rates).length === 0) {
    try {
      await refreshPricingRates(c.env);
      ({ rates, updated_at } = await readPricingRates(c.env));
    } catch (e) {
      console.error('[geo-price] lazy FX refresh failed:', e);
    }
  }

  const { effective, manual } = await readEffective(c.env);
  const cat = priceCatalogue(country, { cfg, rates, baseBySku, overrides: effective, locked: manual });

  const body = {
    country: cat.country,
    zone: cat.zone,
    currency: cat.currency,
    decimals: cat.decimals,
    stripe_hidden: cfg.stripe_hidden_zones.includes(cat.zone),
    updated_at,
    prices: cat.prices,
    base_currency: cfg.base_currency,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      // Price varies by the caller's IP (CF-IPCountry) but that is NOT in the
      // URL — so it must never be shared-cached by URL, or one visitor's country
      // would be served to another (and a VPN/move wouldn't re-price). Keep it
      // per-client and non-stale; the storefront dedups with sessionStorage.
      'Cache-Control': 'private, no-store',
    },
  });
});

export default geoPrice;
