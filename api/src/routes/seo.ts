import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

// =============================================================================
// SEO / GEO site pulse — dasexperten.com snapshots in KV
//
// Live Ubersuggest + Cloudflare GraphQL are pulled by agents (Grok), not by the
// Worker secret path. ERP serves last stored snapshot. Refresh via POST.
//
//   GET/POST /api/seo/site-metrics   — DA / backlinks (Ubersuggest)
//   GET/POST /api/seo/ai-crawlers    — AI bot request counts (Cloudflare UA pull)
// =============================================================================

const CACHE_KEY = 'seo:site:dasexperten.com';
const AI_CRAWLERS_KEY = 'seo:ai-crawlers:dasexperten.com';
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

export type AiCrawlerTile = {
  operator: string;
  bot: string;
  extraBots: number;
  allowed: string;
  allowed_n: number;
  referrals: number;
  bytes?: number;
};

export type AiCrawlersSnapshot = {
  domain: string;
  window_days: number;
  window_start: string;
  window_end: string;
  total_requests: number;
  total_with_search_bots?: number;
  allowed: number;
  allowed_pct: number;
  unsuccessful: number;
  referrals: number;
  source: string;
  /** true only for placeholder; live Cloudflare pulls set false */
  demo: boolean;
  updated_at: number;
  note?: string;
  crawlers: AiCrawlerTile[];
  crawlers_detail?: Array<{ operator: string; bot: string; count: number; bytes?: number }>;
  spark: number[];
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

/** Empty honest shell until first real POST — never invent crawler counts. */
const AI_CRAWLERS_EMPTY: AiCrawlersSnapshot = {
  domain: DOMAIN,
  window_days: 7,
  window_start: '',
  window_end: '',
  total_requests: 0,
  allowed: 0,
  allowed_pct: 0,
  unsuccessful: 0,
  referrals: 0,
  source: 'none',
  demo: true,
  updated_at: 0,
  note: 'No Cloudflare pull stored yet. POST /api/seo/ai-crawlers with a real GraphQL UA snapshot.',
  crawlers: [],
  spark: [],
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

// -----------------------------------------------------------------------------
// AI crawlers — Cloudflare GraphQL UA pull (agent POSTs; UI GETs)
// -----------------------------------------------------------------------------

seo.get('/ai-crawlers', async (c) => {
  const domain = (c.req.query('domain') || DOMAIN).replace(/^www\./, '').toLowerCase();
  const key = domain === DOMAIN ? AI_CRAWLERS_KEY : `seo:ai-crawlers:${domain}`;

  if (c.env.CACHE) {
    try {
      const cached = await c.env.CACHE.get(key, 'json') as AiCrawlersSnapshot | null;
      if (cached && Array.isArray(cached.crawlers)) {
        return ok(c, cached);
      }
    } catch {
      /* empty shell */
    }
  }

  return ok(c, { ...AI_CRAWLERS_EMPTY, domain });
});

seo.post('/ai-crawlers', async (c) => {
  let body: Partial<AiCrawlersSnapshot> = {};
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);
  }

  const domain = String(body.domain || DOMAIN).replace(/^www\./, '').toLowerCase();
  const crawlers = Array.isArray(body.crawlers) ? body.crawlers : [];
  const total = Number(body.total_requests ?? 0);
  if (!Number.isFinite(total)) {
    return fail(c, 400, [{ code: 'invalid', message: 'total_requests must be a number' }]);
  }

  // Hard honesty: refuse demo-flagged payload that claims huge numbers without source
  const demo = body.demo === true;
  const source = String(body.source || (demo ? 'demo' : 'cloudflare_graphql_ua'));

  const snap: AiCrawlersSnapshot = {
    domain,
    window_days: Number(body.window_days ?? 7) || 7,
    window_start: String(body.window_start || ''),
    window_end: String(body.window_end || ''),
    total_requests: total,
    total_with_search_bots: body.total_with_search_bots != null
      ? Number(body.total_with_search_bots)
      : undefined,
    allowed: Number(body.allowed ?? total) || 0,
    allowed_pct: Number(body.allowed_pct ?? 100) || 0,
    unsuccessful: Number(body.unsuccessful ?? 0) || 0,
    referrals: Number(body.referrals ?? 0) || 0,
    source,
    demo,
    updated_at: Math.floor(Date.now() / 1000),
    note: body.note ? String(body.note) : undefined,
    crawlers: crawlers.map((t) => ({
      operator: String(t.operator || ''),
      bot: String(t.bot || ''),
      extraBots: Number(t.extraBots ?? 0) || 0,
      allowed: String(t.allowed ?? t.allowed_n ?? 0),
      allowed_n: Number(t.allowed_n ?? t.allowed ?? 0) || 0,
      referrals: Number(t.referrals ?? 0) || 0,
      bytes: t.bytes != null ? Number(t.bytes) : undefined,
    })),
    crawlers_detail: Array.isArray(body.crawlers_detail)
      ? body.crawlers_detail.map((d) => ({
          operator: String(d.operator || ''),
          bot: String(d.bot || ''),
          count: Number(d.count ?? 0) || 0,
          bytes: d.bytes != null ? Number(d.bytes) : undefined,
        }))
      : undefined,
    spark: Array.isArray(body.spark) ? body.spark.map((n) => Number(n) || 0) : [],
  };

  const key = domain === DOMAIN ? AI_CRAWLERS_KEY : `seo:ai-crawlers:${domain}`;
  if (c.env.CACHE) {
    await c.env.CACHE.put(key, JSON.stringify(snap), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return ok(c, snap);
});

export default seo;
