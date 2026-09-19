// Ozon-only FBO cluster sync. WB FBO sync retired by Owner 2026-09-19.
// Historical WB snapshots are preserved; regular WB stock/sales feeds are separate.
export interface FboEnv {
  DB: D1Database;
  CACHE?: KVNamespace; // sync mutex lives here when bound
  OZON_CLIENT_ID: string;
  OZON_API_KEY: string;
}

const DAYS = 30;

// ---------------------------------------------------------------- helpers

const normSku = (s: string): string =>
  (s || '').toLowerCase().replace(/[\s_-]+/g, '').trim();

// Warehouse lookup key: case- and separator-insensitive
// (ЕКАТЕРИНБУРГ_РФЦ_НОВЫЙ vs Екатеринбург_РФЦ_НОВЫЙ vs САНКТ-ПЕТЕРБУРГ_РФЦ).
const normWh = (s: string): string =>
  (s || '').toUpperCase().replace(/[^A-ZА-ЯЁ0-9]+/gu, '_').replace(/^_+|_+$/g, '');

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

// backoffMs override matters for WB statistics-api: its windows refill
// slowly, so the default 2-6 s ladder just burns attempts inside the same
// closed window (and repeated 429 hits extend the lockout). WB callers pass
// 70 s so a retry lands in a fresh window.
async function fetchRetry(url: string, init: RequestInit, tries = 3, backoffMs = 0): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 && r.status < 500) return r;
    last = r;
    await new Promise((res) => setTimeout(res, backoffMs || 2000 * (i + 1)));
  }
  return last!;
}

// Postings ship from operational RFC warehouses (ЕКАТЕРИНБУРГ_РФЦ_НОВЫЙ,
// САНКТ-ПЕТЕРБУРГ_РФЦ...) that /v1/cluster/list does not always enumerate —
// it covers supply-in topology, not fulfilment. Their names share the city
// token with warehouses the topology DOES know. Resolution order:
//   1) exact match in fbo_cluster_map (manual edits win),
//   2) normalized match (case/separator variants of the same name),
//   3) first name token (before '_') against tokens of known warehouses,
//   4) UNKNOWN (registered for manual review; manual edits persist).
// Generic non-city first tokens (СЦ_, РЦ_, ЛЦ_) are excluded from the index:
// СЦ_ЕКАТЕРИНБУРГ and СЦ_КАЗАНЬ would otherwise collide on 'СЦ' and route
// cartons to whichever city registered first.
const GENERIC_WH_TOKENS = new Set(['СЦ', 'РЦ', 'ЛЦ', 'ТСЦ', 'РФЦ', 'МПСЦ', 'ХАБ']);

export function buildPrefixIndex(map: Map<string, string>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [wh, cluster] of map) {
    if (cluster === 'UNKNOWN') continue;
    const token = normWh(wh).split('_')[0] || '';
    if (token && !GENERIC_WH_TOKENS.has(token) && !idx.has(token)) idx.set(token, cluster);
  }
  return idx;
}

export function resolveCluster(
  wh: string,
  map: Map<string, string>,
  normIdx: Map<string, string>,
  prefixIdx: Map<string, string>,
): string {
  const exact = map.get(wh);
  if (exact && exact !== 'UNKNOWN') return exact;
  const byNorm = normIdx.get(normWh(wh));
  if (byNorm && byNorm !== 'UNKNOWN') return byNorm;
  const token = normWh(wh).split('_')[0] || '';
  if (token && !GENERIC_WH_TOKENS.has(token)) {
    const byPrefix = prefixIdx.get(token);
    if (byPrefix) return byPrefix;
  }
  return 'UNKNOWN';
}

interface ClusterLookup {
  map: Map<string, string>;      // raw name -> cluster (manual edits win)
  normIdx: Map<string, string>;  // normWh(name) -> cluster
  prefixIdx: Map<string, string>;
}

async function loadClusterMap(env: FboEnv, mp: 'ozon' | 'wb'): Promise<ClusterLookup> {
  const { results } = await env.DB
    .prepare('SELECT warehouse_name, cluster FROM fbo_cluster_map WHERE marketplace = ?')
    .bind(mp).all<{ warehouse_name: string; cluster: string }>();
  const map = new Map(results.map((r) => [r.warehouse_name, r.cluster]));
  const normIdx = new Map<string, string>();
  for (const [wh, cluster] of map) {
    const key = normWh(wh);
    const prev = normIdx.get(key);
    if (!prev || prev === 'UNKNOWN') normIdx.set(key, cluster);
  }
  return { map, normIdx, prefixIdx: buildPrefixIndex(map) };
}

async function registerUnknown(env: FboEnv, mp: 'ozon' | 'wb', names: Set<string>): Promise<void> {
  if (!names.size) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO fbo_cluster_map (marketplace, warehouse_name, cluster, updated_at) VALUES (?, ?, ?, ?)'
  );
  await env.DB.batch([...names].map((n) => stmt.bind(mp, n, 'UNKNOWN', now)));
}

// Snapshot writes are a SINGLE transactional batch: DELETE + multi-row
// upsert INSERTs (rows/statement sized to stay under D1's 100-param limit).
// Two overlapping syncs used to interleave at chunk boundaries and tear the
// snapshot (report said 448 rows, table held 198); the KV mutex in
// runFboSync is the first line of defence, this is the second, the upsert
// ON CONFLICT the third.
async function writeSnapshot(
  env: FboEnv,
  table: 'fbo_stocks_cluster' | 'fbo_sales_cluster',
  mp: 'ozon' | 'wb',
  rows: Map<string, number>, // key = `${base_sku}\u0000${cluster}`
  dates?: Map<string, { first: string; last: string }>, // sales only
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const from = isoDaysAgo(DAYS);
  const to = isoDaysAgo(0);
  const batch: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM ${table} WHERE marketplace = ?`).bind(mp),
  ];
  const entries = [...rows];
  const perStmt = table === 'fbo_stocks_cluster' ? 19 : 11; // 5 / 9 params per row
  for (let i = 0; i < entries.length; i += perStmt) {
    const chunk = entries.slice(i, i + perStmt);
    const sql =
      table === 'fbo_stocks_cluster'
        ? 'INSERT INTO fbo_stocks_cluster (marketplace, base_sku, cluster, units, synced_at) VALUES '
          + chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')
          + ' ON CONFLICT (marketplace, base_sku, cluster) DO UPDATE SET units = excluded.units, synced_at = excluded.synced_at'
        : 'INSERT INTO fbo_sales_cluster (marketplace, base_sku, cluster, units_30d, period_from, period_to, first_sale, last_sale, synced_at) VALUES '
          + chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
          + ' ON CONFLICT (marketplace, base_sku, cluster) DO UPDATE SET units_30d = excluded.units_30d, period_from = excluded.period_from, period_to = excluded.period_to, first_sale = excluded.first_sale, last_sale = excluded.last_sale, synced_at = excluded.synced_at';
    const params: (string | number | null)[] = [];
    for (const [key, units] of chunk) {
      const [sku = '', cluster = ''] = key.split('\u0000');
      if (table === 'fbo_stocks_cluster') params.push(mp, sku, cluster, units, now);
      else params.push(mp, sku, cluster, units, from, to, dates?.get(key)?.first ?? null, dates?.get(key)?.last ?? null, now);
    }
    batch.push(env.DB.prepare(sql).bind(...params));
  }
  await env.DB.batch(batch);
  return rows.size;
}

const bump = (m: Map<string, number>, sku: string, cluster: string, n: number): void => {
  const k = `${sku}\u0000${cluster}`;
  m.set(k, (m.get(k) || 0) + n);
};

// Track first/last sale day per (sku, cluster) cell — V2 velocity inputs
// (fbo-calc.ts derives active-days velocity from this span).
const bumpDate = (
  d: Map<string, { first: string; last: string }>,
  sku: string,
  cluster: string,
  day: string,
): void => {
  if (!day) return;
  const k = `${sku}\u0000${cluster}`;
  const cur = d.get(k);
  if (!cur) { d.set(k, { first: day, last: day }); return; }
  if (day < cur.first) cur.first = day;
  if (day > cur.last) cur.last = day;
};

// ------------------------------------------------------------------ Ozon

const ozonHeaders = (env: FboEnv) => ({
  'Client-Id': env.OZON_CLIENT_ID,
  'Api-Key': env.OZON_API_KEY,
  'Content-Type': 'application/json',
});

// Ozon publishes its own warehouse->cluster topology. Refresh it into
// fbo_cluster_map on every run so new Ozon warehouses map themselves.
async function refreshOzonClusterMap(env: FboEnv): Promise<void> {
  const r = await fetchRetry('https://api-seller.ozon.ru/v1/cluster/list', {
    method: 'POST',
    headers: ozonHeaders(env),
    body: JSON.stringify({ cluster_type: 'CLUSTER_TYPE_OZON' }),
  });
  if (!r.ok) throw new Error(`ozon cluster/list HTTP ${r.status}`);
  const data = (await r.json()) as any;
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    'INSERT INTO fbo_cluster_map (marketplace, warehouse_name, cluster, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT (marketplace, warehouse_name) DO UPDATE SET cluster = excluded.cluster, updated_at = excluded.updated_at',
  );
  const batch: D1PreparedStatement[] = [];
  for (const c of data.clusters || []) {
    const clusterName: string = c.name || 'UNKNOWN';
    for (const lc of c.logistic_clusters || []) {
      for (const w of lc.warehouses || []) {
        if (w.name) batch.push(stmt.bind('ozon', w.name, clusterName, now));
      }
    }
  }
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
}

// Stocks come from /v1/analytics/stocks — verified live 2026-07-04.
// (The old /v1/analytics/stock_on_warehouses returns 404: removed by Ozon.)
// The new endpoint takes 1-100 Ozon SKUs per call and returns one row per
// SKU x warehouse WITH cluster_name natively — no warehouse map needed.
async function syncOzonStocks(env: FboEnv): Promise<{ rows: number; unknown: Set<string> }> {
  const { results: skuRows } = await env.DB
    .prepare('SELECT ozon_sku FROM marketplace_ozon_sku_map')
    .all<{ ozon_sku: number }>();
  const skus = skuRows.map((r) => String(r.ozon_sku));
  const agg = new Map<string, number>();
  for (let i = 0; i < skus.length; i += 100) {
    const r = await fetchRetry('https://api-seller.ozon.ru/v1/analytics/stocks', {
      method: 'POST',
      headers: ozonHeaders(env),
      body: JSON.stringify({ skus: skus.slice(i, i + 100) }),
    });
    if (!r.ok) throw new Error(`ozon analytics/stocks HTTP ${r.status}`);
    const data = (await r.json()) as any;
    for (const item of data.items || []) {
      const sku = normSku(item.offer_id);
      if (!sku) continue;
      const cluster = item.cluster_name || 'UNKNOWN';
      bump(agg, sku, cluster, item.available_stock_count || 0);
    }
  }
  const rows = await writeSnapshot(env, 'fbo_stocks_cluster', 'ozon', agg);
  return { rows, unknown: new Set() };
}

// Sales per cluster come from FBO postings (each carries analytics_data
// with the shipping warehouse). Window: trailing 30 days, cancelled skipped.
async function syncOzonSales(env: FboEnv, lookup: ClusterLookup): Promise<{ rows: number; unknown: Set<string> }> {
  const agg = new Map<string, number>();
  const dates = new Map<string, { first: string; last: string }>();
  const unknown = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const r = await fetchRetry('https://api-seller.ozon.ru/v2/posting/fbo/list', {
      method: 'POST',
      headers: ozonHeaders(env),
      body: JSON.stringify({
        dir: 'ASC',
        filter: { since: `${isoDaysAgo(DAYS)}T00:00:00Z`, to: `${isoDaysAgo(0)}T23:59:59Z` },
        limit: 1000,
        offset,
        with: { analytics_data: true, financial_data: false },
      }),
    });
    if (!r.ok) throw new Error(`ozon posting/fbo/list HTTP ${r.status}`);
    const postings = ((await r.json()) as any)?.result || [];
    for (const p of postings) {
      if (p.status === 'cancelled') continue;
      const wh = p?.analytics_data?.warehouse_name || '';
      const cluster = resolveCluster(wh, lookup.map, lookup.normIdx, lookup.prefixIdx);
      if (cluster === 'UNKNOWN') unknown.add(wh);
      const day = String(p.created_at || p.in_process_at || '').slice(0, 10);
      for (const prod of p.products || []) {
        const sku = normSku(prod.offer_id);
        if (!sku) continue;
        bump(agg, sku, cluster, prod.quantity || 0);
        bumpDate(dates, sku, cluster, day);
      }
    }
    if (postings.length < 1000) break;
    offset += 1000;
  }
  const rows = await writeSnapshot(env, 'fbo_sales_cluster', 'ozon', agg, dates);
  return { rows, unknown };
}

// ----------------------------------------------------------- entry point

export interface FboSyncReport {
  ozon: { stocks: number; sales: number; unknown_warehouses: number } | { error: string };
  wb: { skipped: true; reason: string };
}

// Owner 2026-09-19: WB FBO sync is retired; Ozon continues.
export async function runFboSync(env: FboEnv, only?: 'ozon' | 'wb'): Promise<FboSyncReport> {
  const report: FboSyncReport = { ozon: { error: 'not run' }, wb: { skipped: true, reason: 'WB FBO sync retired by Owner 2026-09-19' } };
  if (only === 'wb') return report;

  // Mutex: two overlapping syncs (manual + cron, or two manual) interleave
  // DELETE/INSERT and tear the snapshot — seen live 2026-07-04. KV lock
  // covers the run; the transactional writes above are the second line.
  const LOCK = 'fbo:sync:lock';
  if (env.CACHE) {
    if (await env.CACHE.get(LOCK)) {
      const busy = { error: 'sync already running (lock held)' };
      return { ozon: busy, wb: report.wb };
    }
    await env.CACHE.put(LOCK, String(Date.now()), { expirationTtl: 900 });
  }
  try {
    {
      try {
        await refreshOzonClusterMap(env); // needed by sales (postings carry warehouse_name only)
        const lookup = await loadClusterMap(env, 'ozon');
        const st = await syncOzonStocks(env);
        const sa = await syncOzonSales(env, lookup);
        const unk = new Set([...st.unknown, ...sa.unknown]);
        await registerUnknown(env, 'ozon', unk);
        report.ozon = { stocks: st.rows, sales: sa.rows, unknown_warehouses: unk.size };
      } catch (e) {
        report.ozon = { error: e instanceof Error ? e.message : String(e) };
        console.error('[fbo-sync] ozon failed:', e);
      }
    }
    return report;
  } finally {
    if (env.CACHE) await env.CACHE.delete(LOCK);
  }
}
