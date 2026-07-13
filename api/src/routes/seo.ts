import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

// =============================================================================
// SEO site pulse — home dashboard cards for dasexperten.com (Ubersuggest snapshot)
//
// Live Ubersuggest is OAuth/MCP (Grok), not a Worker secret. So the ERP always
// serves the last stored snapshot from KV. Refresh via:
//   POST /api/seo/site-metrics  { domain_authority, backlinks, ref_domains, organic_traffic }
// or re-seed defaults when KV is empty.
// =============================================================================

const CACHE_KEY = 'seo:site:dasexperten.com';
const DOMAIN = 'dasexperten.com';

export type SiteSeoMetrics = {
  domain: string;
  domain_authority: number;
  backlinks: number;
  ref_domains: number;
  organic_traffic: number;
  /** unix seconds */
  updated_at: number;
  source: 'ubersuggest' | 'seed';
};

/** Last known good pull (Grok MCP 2026-07-13) — used until first POST refresh. */
const SEED: SiteSeoMetrics = {
  domain: DOMAIN,
  domain_authority: 11,
  backlinks: 1093,
  ref_domains: 328,
  organic_traffic: 124,
  updated_at: Math.floor(Date.now() / 1000),
  source: 'seed',
};

const seo = new Hono<{ Bindings: Env }>();

seo.get('/site-metrics', async (c) => {
  const domain = (c.req.query('domain') || DOMAIN).replace(/^www\./, '').toLowerCase();
  const key = domain === DOMAIN ? CACHE_KEY : `seo:site:${domain}`;

  if (c.env.CACHE) {
    try {
      const cached = await c.env.CACHE.get(key, 'json') as SiteSeoMetrics | null;
      if (cached && typeof cached.domain_authority === 'number') {
        return ok(c, cached);
      }
    } catch {
      /* fall through to seed */
    }
  }

  // Persist seed so subsequent loads are fast and stable
  if (c.env.CACHE && domain === DOMAIN) {
    try {
      await c.env.CACHE.put(CACHE_KEY, JSON.stringify(SEED), { expirationTtl: 60 * 60 * 24 * 30 });
    } catch { /* ignore */ }
  }

  return ok(c, domain === DOMAIN ? SEED : {
    domain,
    domain_authority: 0,
    backlinks: 0,
    ref_domains: 0,
    organic_traffic: 0,
    updated_at: Math.floor(Date.now() / 1000),
    source: 'seed' as const,
  });
});

/** Push a fresh Ubersuggest snapshot (from Grok daily task or manual). */
seo.post('/site-metrics', async (c) => {
  let body: Partial<SiteSeoMetrics> = {};
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }

  const domain = String(body.domain || DOMAIN).replace(/^www\./, '').toLowerCase();
  const metrics: SiteSeoMetrics = {
    domain,
    domain_authority: Number(body.domain_authority ?? 0),
    backlinks: Number(body.backlinks ?? 0),
    ref_domains: Number(body.ref_domains ?? 0),
    organic_traffic: Number(body.organic_traffic ?? 0),
    updated_at: Math.floor(Date.now() / 1000),
    source: 'ubersuggest',
  };

  if (!Number.isFinite(metrics.domain_authority)) {
    return fail(c, 400, [{ code: 'invalid', message: 'domain_authority required' }]);
  }

  const key = domain === DOMAIN ? CACHE_KEY : `seo:site:${domain}`;
  if (c.env.CACHE) {
    await c.env.CACHE.put(key, JSON.stringify(metrics), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return ok(c, metrics);
});

export default seo;
