// api/src/marketplaces/fbo-sync.ts
//
// FBO supply planning — cluster-grain data sync.
// Writes fbo_stocks_cluster / fbo_sales_cluster (migration 0058_fbo_cluster_grain.sql).
//
// Self-contained: no imports from the rest of the app. Wire-up (separate round):
//   scheduled.ts  -> if (hour === 5) await runFboSync(env)   // daily 05:00 UTC = 08:00 MSK
//   routes        -> POST /api/marketplaces/fbo/sync -> runFboSync(env)
//
// Design decisions (approved methodology, April 2026 + this session):
//   - Grain: (marketplace, base_sku, cluster). base_sku = lowercase article,
//     spaces stripped — same convention as marketplace_stocks_* tables.
//     Multipack listings (DE201 AA) are their own base_sku, so raw units
//     aggregate cleanly without pack_factor math.
//   - Snapshot semantics: each run DELETEs the marketplace slice and rewrites.
//   - Unknown warehouses are inserted into fbo_cluster_map as UNKNOWN for
//     manual review; their rows still land in stocks/sales under 'UNKNOWN'.
//   - WB returns (saleID starting with 'R') and cancelled sales are excluded.
//   - Ozon paid-storage exclusions are NOT applied here — calc's job.

export interface FboEnv {
  DB: D1Database;
  OZON_CLIENT_ID: string;
  OZON_API_KEY: string;
  WB_API_TOKEN: string;
}

const DAYS = 30;

// ---------------------------------------------------------------- helpers

const normSku = (s: string): string =>
  (s || '').toLowerCase().replace(/[\s_-]+/g, '').trim();

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, init);
    if (r.status !== 429 && r.status < 500) return r;
    last = r;
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  return last!;
}

async function loadClusterMap(env: FboEnv, mp: 'ozon' | 'wb'): Promise<Map<string, string>> {
  const { results } = await env.DB
    .prepare('SELECT warehouse_name, cluster FROM fbo_cluster_map WHERE marketplace = ?')
    .bind(mp).all<{ warehouse_name: string; cluster: string }>();
  return new Map(results.map((r) => [r.warehouse_name, r.cluster]));
}

async function registerUnknown(env: FboEnv, mp: 'ozon' | 'wb', names: Set<string>): Promise<void> {
  if (!names.size) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO fbo_cluster_map (marketplace, warehouse_name, cluster, updated_at) VALUES (?, ?, ?, ?)'
  );
  await env.DB.batch([...names].map((n) => stmt.bind(mp, n, 'UNKNOWN', now)));
}

async function writeSnapshot(
  env: FboEnv,
  table: 'fbo_stocks_cluster' | 'fbo_sales_cluster',
  mp: 'ozon' | 'wb',
  rows: Map<string, number>, // key = `${base_sku}\u0000${cluster}`
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM ${table} WHERE marketplace = ?`).bind(mp).run();
  const stmt =
    table === 'fbo_stocks_cluster'
      ? env.DB.prepare('INSERT INTO fbo_stocks_cluster (marketplace, base_sku, cluster, units, synced_at) VALUES (?, ?, ?, ?, ?)')
      : env.DB.prepare('INSERT INTO fbo_sales_cluster (marketplace, base_sku, cluster, units_30d, period_from, period_to, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const from = isoDaysAgo(DAYS);
  const to = isoDaysAgo(0);
  const batch: D1PreparedStatement[] = [];
  for (const [key, units] of rows) {
    const [sku, cluster] = key.split('\u0000');
    batch.push(
      table === 'fbo_stocks_cluster'
        ? stmt.bind(mp, sku, cluster, units, now)
        : stmt.bind(mp, sku, cluster, units, from, to, now),
    );
  }
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  return rows.size;
}

const bump = (m: Map<string, number>, sku: string, cluster: string, n: number): void => {
  const k = `${sku}\u0000${cluster}`;
  m.set(k, (m.get(k) || 0) + n);
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
async function syncOzonSales(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const agg = new Map<string, number>();
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
      let cluster = map.get(wh);
      if (!cluster) { cluster = 'UNKNOWN'; unknown.add(wh); }
      for (const prod of p.products || []) {
        const sku = normSku(prod.offer_id);
        if (sku) bump(agg, sku, cluster, prod.quantity || 0);
      }
    }
    if (postings.length < 1000) break;
    offset += 1000;
  }
  const rows = await writeSnapshot(env, 'fbo_sales_cluster', 'ozon', agg);
  return { rows, unknown };
}

// -------------------------------------------------------------------- WB

const wbHeaders = (env: FboEnv) => ({ Authorization: env.WB_API_TOKEN });

async function syncWbStocks(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const r = await fetchRetry(
    'https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=2019-06-20',
    { headers: wbHeaders(env) },
  );
  if (!r.ok) throw new Error(`wb supplier/stocks HTTP ${r.status}`);
  const rows = (await r.json()) as any[];
  const agg = new Map<string, number>();
  const unknown = new Set<string>();
  for (const row of rows || []) {
    const sku = normSku(row.supplierArticle);
    if (!sku) continue;
    const wh = row.warehouseName || '';
    let cluster = map.get(wh);
    if (!cluster) { cluster = 'UNKNOWN'; unknown.add(wh); }
    bump(agg, sku, cluster, row.quantity || 0);
  }
  const n = await writeSnapshot(env, 'fbo_stocks_cluster', 'wb', agg);
  return { rows: n, unknown };
}

async function syncWbSales(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const r = await fetchRetry(
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${isoDaysAgo(DAYS)}&flag=0`,
    { headers: wbHeaders(env) },
  );
  if (!r.ok) throw new Error(`wb supplier/sales HTTP ${r.status}`);
  const rows = (await r.json()) as any[];
  const agg = new Map<string, number>();
  const unknown = new Set<string>();
  for (const row of rows || []) {
    if (typeof row.saleID === 'string' && row.saleID.startsWith('R')) continue; // return
    if (row.isCancel) continue;
    const sku = normSku(row.supplierArticle);
    if (!sku) continue;
    const wh = row.warehouseName || '';
    let cluster = map.get(wh);
    if (!cluster) { cluster = 'UNKNOWN'; unknown.add(wh); }
    bump(agg, sku, cluster, 1); // one row = one sold unit
  }
  const n = await writeSnapshot(env, 'fbo_sales_cluster', 'wb', agg);
  return { rows: n, unknown };
}

// ----------------------------------------------------------- entry point

export interface FboSyncReport {
  ozon: { stocks: number; sales: number; unknown_warehouses: number } | { error: string };
  wb:   { stocks: number; sales: number; unknown_warehouses: number } | { error: string };
}

export async function runFboSync(env: FboEnv): Promise<FboSyncReport> {
  const report: FboSyncReport = { ozon: { error: 'not run' }, wb: { error: 'not run' } };

  try {
    await refreshOzonClusterMap(env); // needed by sales (postings carry warehouse_name only)
    const map = await loadClusterMap(env, 'ozon');
    const st = await syncOzonStocks(env);
    const sa = await syncOzonSales(env, map);
    const unk = new Set([...st.unknown, ...sa.unknown]);
    await registerUnknown(env, 'ozon', unk);
    report.ozon = { stocks: st.rows, sales: sa.rows, unknown_warehouses: unk.size };
  } catch (e) {
    report.ozon = { error: e instanceof Error ? e.message : String(e) };
    console.error('[fbo-sync] ozon failed:', e);
  }

  // WB statistics-api is rate-limited (~1 req/min): pause between the
  // Ozon block and the two WB calls, and between the WB calls themselves.
  await new Promise((res) => setTimeout(res, 5000));

  try {
    const map = await loadClusterMap(env, 'wb');
    const st = await syncWbStocks(env, map);
    await new Promise((res) => setTimeout(res, 65_000)); // WB rate limit
    const sa = await syncWbSales(env, map);
    const unk = new Set([...st.unknown, ...sa.unknown]);
    await registerUnknown(env, 'wb', unk);
    report.wb = { stocks: st.rows, sales: sa.rows, unknown_warehouses: unk.size };
  } catch (e) {
    report.wb = { error: e instanceof Error ? e.message : String(e) };
    console.error('[fbo-sync] wb failed:', e);
  }

  return report;
}
