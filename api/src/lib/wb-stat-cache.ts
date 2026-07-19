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
// Window semantics: stocks is always the full current snapshot (the new
// stocks-report endpoint takes no window); supplier/sales is fetched for a trailing WINDOW_DAYS
// (30) superset with flag=0 — consumers that need a narrower window (7d
// daily sales) filter rows client-side, which they already did. Callers
// that need MORE than 30 days (?days=N backfills) pass windowDays > 30 and
// get a direct uncached fetch, leaving the shared cache intact.

export interface WbStatEnv {
  DB: D1Database; // nmId -> supplierArticle map for the new stocks endpoint
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

  // STOCKS migrated off the deprecated GET /api/v1/supplier/stocks
  // (WB release note id=494 — quota slashed to nothing, every worker call
  // 429s). New source: POST seller-analytics-api /stocks-report/wb-warehouses.
  // Its rows are keyed by nmId and carry regionName natively; adaptWbStocks
  // converts them back into the legacy supplier/stocks row shape so the two
  // existing consumers (FBO cluster sync, marketplace_stocks_wb) stay
  // untouched. SALES stays on statistics-api — not deprecated (as of 07-2026).
  const days = cacheable ? WINDOW_DAYS : windowDays;
  const dateFrom = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const isStocks = kind === 'stocks';
  const url = isStocks
    ? 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses'
    : `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${dateFrom}&flag=0`;

  const tries = Math.max(1, opts.tries ?? 1);
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, {
      method: isStocks ? 'POST' : 'GET',
      headers: {
        Authorization: env.WB_API_TOKEN,
        ...(isStocks ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(isStocks ? { body: '{}' } : {}),
    });
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
  const payload = (await last.json()) as any;
  const rows = isStocks
    ? await adaptWbStocks(env, payload?.data?.items || [])
    : (payload as any[]);
  if (cacheable) {
    await env.CACHE!.put(key, JSON.stringify(rows), { expirationTtl: CACHE_TTL_S });
  }
  return { rows, fromCache: false };
}

// New stocks-report rows -> legacy supplier/stocks row shape.
//   { nmId, warehouseName, regionName, quantity, inWayToClient, inWayFromClient }
//   -> { supplierArticle, nmId, warehouseName, quantity, inWayToClient,
//        inWayFromClient, quantityFull }
// supplierArticle comes from marketplace_stocks_wb (nm_id column, populated by
// years of old-API syncs). Rows whose nmId has no mapping yet are dropped with
// a console warning — a brand-new listing will map itself after it first
// appears in the sales feed / product sync. quantityFull is synthesized as
// quantity + both in-way legs (the old field's definition).
async function adaptWbStocks(env: WbStatEnv, items: any[]): Promise<any[]> {
  const { results } = await env.DB
    .prepare('SELECT DISTINCT nm_id, supplier_article FROM marketplace_stocks_wb WHERE nm_id IS NOT NULL')
    .all<{ nm_id: number; supplier_article: string }>();
  const byNm = new Map(results.map((r) => [r.nm_id, r.supplier_article]));
  const unmapped = new Set<number>();
  const rows: any[] = [];
  for (const it of items) {
    const article = byNm.get(it.nmId);
    if (!article) { unmapped.add(it.nmId); continue; }
    const quantity = it.quantity || 0;
    const toClient = it.inWayToClient || 0;
    const fromClient = it.inWayFromClient || 0;
    rows.push({
      supplierArticle: article,
      nmId: it.nmId,
      warehouseName: it.warehouseName || '',
      regionName: it.regionName || '',
      quantity,
      inWayToClient: toClient,
      inWayFromClient: fromClient,
      quantityFull: quantity + toClient + fromClient,
    });
  }
  if (unmapped.size) {
    console.warn(`[wb-stat-cache] ${unmapped.size} nmIds without article mapping dropped: ${[...unmapped].slice(0, 10).join(', ')}`);
  }
  return rows;
}
