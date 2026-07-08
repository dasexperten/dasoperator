import { Hono } from 'hono';
import type { Env } from '../types';
import zones from '../pricing/zones.json';
import basePrices from '../pricing/base-prices.json';
import { priceCatalogue, type ZonesConfig } from '../pricing/resolver';
import { readPricingRates, refreshPricingRates } from '../lib/fx-pricing';

// =============================================================================
// GET /geo-price — public zonal price feed for the storefront.
//
// Resolves the visitor's country (dx_region cookie > ?country= > CF-IPCountry),
// then returns { country, zone, currency, decimals, updated_at, prices }, where
// prices = { SKU: amount } computed EUR base x daily FX x psychological rounding.
//
// Public (no auth, no credentials). Own permissive CORS for the two .com
// storefront origins. Edge-cached 1h per full URL (country in the query).
// Display only — the charge is always repriced server-side at checkout.
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

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const ISO2 = /^[A-Za-z]{2}$/;

const geoPrice = new Hono<{ Bindings: Env }>();

geoPrice.options('/', (c) => new Response(null, { status: 204, headers: corsFor(c.req.header('Origin')) }));

geoPrice.get('/', async (c) => {
  const cors = corsFor(c.req.header('Origin'));

  // Resolution order: dx_region cookie wins, then ?country=, then IP geo.
  const cookieRegion = readCookie(c.req.header('Cookie'), 'dx_region');
  const qCountry = c.req.query('country');
  const ipCountry = c.req.header('CF-IPCountry');
  let country = cookieRegion || qCountry || ipCountry || '';
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

  const cat = priceCatalogue(country, { cfg, rates, baseBySku });

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
      // Per-country edge cache, 1h; SWR keeps it warm past expiry.
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
});

export default geoPrice;
