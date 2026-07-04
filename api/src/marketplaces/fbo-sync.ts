// api/src/marketplaces/fbo-sync.ts
//
// FBO supply planning — cluster-grain data sync.
// Writes fbo_stocks_cluster / fbo_sales_cluster (migrations 0058 + 0059).
//
// Self-contained: no imports from the rest of the app. Wire-up:
//   scheduled.ts  -> '0 5 * * *' branch: ctx.waitUntil(runFboSync(env))
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
//   - Warehouse lookup is NORMALIZED (upper-case, separators -> '_'): Ozon
//     postings report АЛМАТЫ_2_РФЦ / САНКТ-ПЕТЕРБУРГ_РФЦ while cluster/list
//     publishes Алматы_2_РФЦ / Санкт_Петербург_РФЦ — same warehouse, three
//     spellings. First prod run stranded 25% of sales in UNKNOWN over this.
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

// Warehouse lookup key: case- and separator-insensitive.
const normWh = (s: string): string =>
  (s || '').toUpperCase().replace(/[^A-ZА-ЯЁ0-9]+/gu, '_').replace(/^_+|_+$/g, '');

const isoDaysAgo = (d: number): string =>
  new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

// backoffMs override matters for WB statistics-api: its per-token buckets
// refill slowly, so the default 2-6 s ladder just burns attempts inside the
// same closed window (and repeated 429 hits extend the lockout). WB callers
// pass 70 s so a retry lands in a fresh window.
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

// Lookup map keyed by normWh(). When several raw spellings collapse to one
// key, a real cluster always beats UNKNOWN (registerUnknown rows must not
// shadow the cluster/list truth).
async function loadClusterMap(env: FboEnv, mp: 'ozon' | 'wb'): Promise<Map<string, string>> {
  const { results } = await env.DB
    .prepare('SELECT warehouse_name, cluster FROM fbo_cluster_map WHERE marketplace = ?')
    .bind(mp).all<{ warehouse_name: string; cluster: string }>();
  const map = new Map<string, string>();
  for (const r of results) {
    const key = normWh(r.warehouse_name);
    const prev = map.get(key);
    if (!prev || prev === 'UNKNOWN') map.set(key, r.cluster);
  }
  return map;
}

async function registerUnknown(env: FboEnv, mp: 'ozon' | 'wb', names: Set<string>): Promise<void> {
  if (!names.size) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO fbo_cluster_map (marketplace, warehouse_name, cluster, updated_at) VALUES (?, ?, ?, ?)'
  );
  await env.DB.batch([...names].map((n) => stmt.bind(mp, n, 'UNKNOWN', now)));
}

type SalesCell = { units: number; first: string; last: string };

async function writeStocksSnapshot(env: FboEnv, mp: 'ozon' | 'wb', rows: Map<string, number>): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM fbo_stocks_cluster WHERE marketplace = ?').bind(mp).run();
  const stmt = env.DB.prepare(
    'INSERT INTO fbo_stocks_cluster (marketplace, base_sku, cluster, units, synced_at) VALUES (?, ?, ?, ?, ?)');
  const batch: D1PreparedStatement[] = [];
  for (const [key, units] of rows) {
    const [sku, cluster] = key.split('\u0000');
    batch.push(stmt.bind(mp, sku, cluster, units, now));
  }
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  return rows.size;
}

async function writeSalesSnapshot(env: FboEnv, mp: 'ozon' | 'wb', rows: Map<string, SalesCell>): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM fbo_sales_cluster WHERE marketplace = ?').bind(mp).run();
  const stmt = env.DB.prepare(
    'INSERT INTO fbo_sales_cluster (marketplace, base_sku, cluster, units_30d, period_from, period_to, first_sale, last_sale, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const from = isoDaysAgo(DAYS);
  const to = isoDaysAgo(0);
  const batch: D1PreparedStatement[] = [];
  for (const [key, c] of rows) {
    const [sku, cluster] = key.split('\u0000');
    batch.push(stmt.bind(mp, sku, cluster, c.units, from, to, c.first, c.last, now));
  }
  for (let i = 0; i < batch.length; i += 50) await env.DB.batch(batch.slice(i, i + 50));
  return rows.size;
}

const bump = (m: Map<string, number>, sku: string, cluster: string, n: number): void => {
  const k = `${sku}\u0000${cluster}`;
  m.set(k, (m.get(k) || 0) + n);
};

// One sale event: accumulate units and stretch the first/last sale span —
// the denominator of Product Velocity in fbo-calc.
const bumpSale = (m: Map<string, SalesCell>, sku: string, cluster: string, n: number, date: string): void => {
  const k = `${sku}\u0000${cluster}`;
  const c = m.get(k);
  if (!c) { m.set(k, { units: n, first: date, last: date }); return; }
  c.units += n;
  if (date < c.first) c.first = date;
  if (date > c.last) c.last = date;
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
  const rows = await writeStocksSnapshot(env, 'ozon', agg);
  return { rows, unknown: new Set() };
}

// Sales per cluster come from FBO postings (each carries analytics_data
// with the shipping warehouse). Window: trailing 30 days, cancelled skipped.
async function syncOzonSales(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const agg = new Map<string, SalesCell>();
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
      let cluster = map.get(normWh(wh));
      if (!cluster || cluster === 'UNKNOWN') { cluster = 'UNKNOWN'; unknown.add(wh); }
      const date = String(p.created_at || p.in_process_at || '').slice(0, 10) || isoDaysAgo(0);
      for (const prod of p.products || []) {
        const sku = normSku(prod.offer_id);
        if (sku) bumpSale(agg, sku, cluster, prod.quantity || 0, date);
      }
    }
    if (postings.length < 1000) break;
    offset += 1000;
  }
  const rows = await writeSalesSnapshot(env, 'ozon', agg);
  return { rows, unknown };
}

// -------------------------------------------------------------------- WB

const wbHeaders = (env: FboEnv) => ({ Authorization: env.WB_API_TOKEN });

async function syncWbStocks(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const r = await fetchRetry(
    'https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=2019-06-20',
    { headers: wbHeaders(env) },
    3,
    70_000,
  );
  if (!r.ok) throw new Error(`wb supplier/stocks HTTP ${r.status}`);
  const rows = (await r.json()) as any[];
  const agg = new Map<string, number>();
  const unknown = new Set<string>();
  for (const row of rows || []) {
    const sku = normSku(row.supplierArticle);
    if (!sku) continue;
    const wh = row.warehouseName || '';
    let cluster = map.get(normWh(wh));
    if (!cluster || cluster === 'UNKNOWN') { cluster = 'UNKNOWN'; unknown.add(wh); }
    bump(agg, sku, cluster, row.quantity || 0);
  }
  const n = await writeStocksSnapshot(env, 'wb', agg);
  return { rows: n, unknown };
}

async function syncWbSales(env: FboEnv, map: Map<string, string>): Promise<{ rows: number; unknown: Set<string> }> {
  const r = await fetchRetry(
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${isoDaysAgo(DAYS)}&flag=0`,
    { headers: wbHeaders(env) },
    3,
    70_000,
  );
  if (!r.ok) throw new Error(`wb supplier/sales HTTP ${r.status}`);
  const rows = (await r.json()) as any[];
  const agg = new Map<string, SalesCell>();
  const unknown = new Set<string>();
  for (const row of rows || []) {
    if (typeof row.saleID === 'string' && row.saleID.startsWith('R')) continue; // return
    if (row.isCancel) continue;
    const sku = normSku(row.supplierArticle);
    if (!sku) continue;
    const wh = row.warehouseName || '';
    let cluster = map.get(normWh(wh));
    if (!cluster || cluster === 'UNKNOWN') { cluster = 'UNKNOWN'; unknown.add(wh); }
    const date = String(row.date || '').slice(0, 10) || isoDaysAgo(0);
    bumpSale(agg, sku, cluster, 1, date); // one row = one sold unit
  }
  const n = await writeSalesSnapshot(env, 'wb', agg);
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

  // WB statistics-api is rate-limited: pause between the Ozon block and the
  // two WB calls, and between the WB calls themselves.
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
