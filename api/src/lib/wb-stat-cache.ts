// api/src/lib/wb-stat-cache.ts
//
// Single shared fetch for WB statistics-api raw feeds (supplier/stocks,
// supplier/sales). The per-account quota on these endpoints is tiny and
// shared by every consumer in the worker (FBO cluster sync, legacy stocks
// table, daily sales table) — three code paths used to fetch the SAME
// payload back-to-back and 429 each other. This helper caches the raw JSON
// body in KV for CACHE_TTL_S, so within one window only the first caller
// pays a real HTTP request; everyone else reuses the body.
//
// Window semantics: supplier/stocks ignores dateFrom and returns the full
// current snapshot; supplier/sales is fetched for a trailing WINDOW_DAYS
// (30) superset with flag=0 — consumers that need a narrower window (7d
// daily sales) filter rows client-side, which they already did. Callers
// that need MORE than 30 days (?days=N backfills) pass windowDays > 30 and
// get a direct uncached fetch, leaving the shared cache intact.

export interface WbStatEnv {
  CACHE?: KVNamespace;
  WB_API_TOKEN: string;
}

export type WbStatKind = 'stocks' | 'sales';

const CACHE_TTL_S = 1800; // 30 min — one cron chain reuses one body
const WINDOW_DAYS = 30;

export interface WbStatOpts {
  tries?: number;      // retry attempts on 429/5xx (default 1 — interactive callers)
  backoffMs?: number;  // fixed backoff between retries (default 2s*attempt ladder)
  windowDays?: number; // sales lookback; > WINDOW_DAYS bypasses the cache
  forceFresh?: boolean;
}

export async function fetchWbStat(
  env: WbStatEnv,
  kind: WbStatKind,
  opts: WbStatOpts = {},
): Promise<{ rows: any[]; fromCache: boolean }> {
  if (!env.WB_API_TOKEN) throw new Error('WB_API_TOKEN not configured');
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const cacheable = !!env.CACHE && windowDays <= WINDOW_DAYS;
  const key = `wbstat:${kind}`;

  if (cacheable && !opts.forceFresh) {
    const hit = await env.CACHE!.get(key);
    if (hit) return { rows: JSON.parse(hit) as any[], fromCache: true };
  }

  // Cacheable fetches always use the full WINDOW_DAYS superset so any
  // consumer can be served from the same body.
  const days = cacheable ? WINDOW_DAYS : windowDays;
  const dateFrom = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const url =
    `https://statistics-api.wildberries.ru/api/v1/supplier/${kind}` +
    `?dateFrom=${dateFrom}${kind === 'sales' ? '&flag=0' : ''}`;

  const tries = Math.max(1, opts.tries ?? 1);
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: env.WB_API_TOKEN } });
    last = r;
    if (r.status !== 429 && r.status < 500) break;
    if (i < tries - 1) {
      await new Promise((res) => setTimeout(res, opts.backoffMs || 2000 * (i + 1)));
    }
  }
  if (!last || !last.ok) {
    const body = last ? (await last.text()).slice(0, 300) : 'no response';
    throw new Error(`WB API ${last?.status ?? 0}: ${body}`);
  }
  const rows = (await last.json()) as any[];
  if (cacheable) {
    await env.CACHE!.put(key, JSON.stringify(rows), { expirationTtl: CACHE_TTL_S });
  }
  return { rows, fromCache: false };
}
