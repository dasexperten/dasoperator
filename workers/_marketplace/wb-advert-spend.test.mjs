import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchWbAdvertSpend } from './wb-advert-spend.mjs';
import { syncWbSalesToErp } from './erp-sales-sync.mjs';

const mapping = [{ nm_id: 101, supplier_article: 'DE209' }, { nm_id: 102, supplier_article: 'DE203AA' }];
const list = { adverts: [9, 11, 7].map((status, i) => ({ status, advert_list: [{ advertId: i + 1 }] })) };
function stat(id, day, nms) { return { advertId: id, currency: 'RUB', days: [{ date: day, apps: [{ nms }] }] }; }
function envFor(response) {
  return {
    ERP_DB: { prepare: () => ({ all: async () => ({ results: mapping }) }) },
    WB_GATEWAY: { fetch: async input => {
      const url = new URL(input);
      return Response.json(url.pathname.endsWith('/count') ? list : response(url));
    } },
  };
}

test('sum actual nested SKU spend across campaigns and apps, never campaign total per SKU', async () => {
  const env = envFor(() => [stat(1, '2026-10-02', [{ nmId: 101, sum: 12.34 }, { nmId: 102, sum: 5 }]),
    stat(2, '2026-10-02', [{ nmId: 101, sum: 2.11 }])]);
  const result = await fetchWbAdvertSpend(env, '2026-09-25', '2026-10-02');
  assert.equal(result.campaigns, 3);
  assert.deepEqual([...result.spend], [['de209', 1445], ['de203aa', 500]]);
});

test('include completed and paused IDs, split long periods without overlap', async () => {
  const calls = [];
  const env = envFor(url => { calls.push(url); return []; });
  await fetchWbAdvertSpend(env, '2026-08-01', '2026-10-02');
  assert.deepEqual(calls.map(u => [u.searchParams.get('beginDate'), u.searchParams.get('endDate')]),
    [['2026-08-01','2026-08-31'], ['2026-09-01','2026-10-01'], ['2026-10-02','2026-10-02']]);
  assert.equal(calls[0].searchParams.get('ids'), '1,2,3');
});

test('50-ID request ceiling preserves all campaigns', async () => {
  const calls = [];
  const env = envFor(() => []);
  env.WB_GATEWAY.fetch = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/count')) return Response.json({ adverts: [{ status: 9,
      advert_list: Array.from({ length: 51 }, (_, i) => ({ advertId: i + 1 })) }] });
    calls.push(url.searchParams.get('ids').split(',')); return Response.json([]);
  };
  await fetchWbAdvertSpend(env, '2026-10-02', '2026-10-02');
  assert.deepEqual(calls.map(x => x.length), [50, 1]);
});

test('reject missing breakdown, non-RUB and unmapped paid SKU instead of dropping costs', async () => {
  for (const rows of [[{ advertId: 1, sum: 5, days: [] }],
    [{ ...stat(1, '2026-10-02', []), currency: 'UZS' }],
    [stat(1, '2026-10-02', [{ nmId: 999, sum: 10 }])]]) {
    await assert.rejects(fetchWbAdvertSpend(envFor(() => rows), '2026-10-02', '2026-10-02'), /WB advertising/);
  }
});

test('WB null fullstats means no statistics: counted, not an error, not silent', async () => {
  const result = await fetchWbAdvertSpend(envFor(() => null), '2026-10-02', '2026-10-02');
  assert.equal(result.emptyBatches, 1);
  assert.equal(result.spend.size, 0);
  await assert.rejects(fetchWbAdvertSpend(envFor(() => ({ error: true })), '2026-10-02', '2026-10-02'), /malformed fullstats \(object/);
});

function integrationEnv(fail = false) {
  // Python SQLite matches the existing gateway test harness and works on Node20 CI.
  const folder = mkdtempSync(join(tmpdir(), 'wb-spend-test-'));
  const file = join(folder, 'db.sqlite');
  function sql(query, args = [], script = false) {
    const result = spawnSync('python3', ['-c', `import sqlite3,json,sys
q,a,script=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if script: c.executescript(q);rows=[];rid=0
else:
 cursor=c.execute(q,a);rows=[dict(r) for r in cursor.fetchall()];rid=cursor.lastrowid
c.commit();print(json.dumps({'rows':rows,'lastInsertRowid':rid}))`, file],
      { input: JSON.stringify([query,args,script]), encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  }
  const db = { exec(query) { if (!['BEGIN','COMMIT','ROLLBACK'].includes(query)) sql(query, [], true); },
    prepare(query) { return { all: (...args) => sql(query,args).rows,
      get: (...args) => sql(query,args).rows[0], run: (...args) => sql(query,args) }; },
    close() { rmSync(folder, { recursive: true, force: true }); } };
  db.exec(`CREATE TABLE products(id TEXT,deleted_at INTEGER);
    INSERT INTO products VALUES ('de209',NULL),('de203aa',NULL);
    CREATE TABLE marketplace_stocks_wb(nm_id INTEGER,supplier_article TEXT);
    INSERT INTO marketplace_stocks_wb VALUES(101,'DE209'),(102,'DE203AA');
    CREATE TABLE marketplace_sync_log(id INTEGER PRIMARY KEY,marketplace TEXT,started_at INTEGER,status TEXT,finished_at INTEGER,rows_synced INTEGER,error_message TEXT);
    CREATE TABLE marketplace_sales_wb(base_sku TEXT PRIMARY KEY,period_from TEXT,period_to TEXT,units_sold INTEGER,revenue_rub INTEGER,listings_count INTEGER,synced_at INTEGER,views INTEGER,tocart_count INTEGER,position_category REAL,current_price_rub INTEGER,ad_spend_rub INTEGER,prev_period_units_sold INTEGER,prev_period_revenue_rub INTEGER,anomaly TEXT);
    INSERT INTO marketplace_sales_wb(base_sku,ad_spend_rub) VALUES('old',12345);
    CREATE TABLE marketplace_sales_daily(marketplace TEXT,date TEXT,units_sold INTEGER,revenue_rub INTEGER,synced_at INTEGER,PRIMARY KEY(marketplace,date));`);
  const wrap = sql => ({ sql, args: [], bind(...args) { this.args = args; return this; },
    async all() { return { results: db.prepare(sql).all(...this.args) }; },
    async run() { const r = db.prepare(sql).run(...this.args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; } });
  const env = { ERP_DB: { prepare: wrap, batch: async statements => {
    db.exec('BEGIN'); try { for (const s of statements) await s.run(); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } }, WB_GATEWAY: { fetch: async input => {
    const u = new URL(input);
    if (u.pathname.endsWith('/supplier/sales')) return Response.json([{ supplierArticle: 'DE209', date: new Date().toISOString(), priceWithDisc: 700 }]);
    if (u.pathname.includes('sales-funnel')) return Response.json({ data: { products: [] } });
    if (u.pathname.includes('/goods/filter')) return Response.json({ data: { listGoods: [] } });
    if (u.pathname.endsWith('/count')) return fail ? new Response('', { status: 403 }) : Response.json(list);
    return Response.json([stat(1, u.searchParams.get('endDate'), [{ nmId: 101, sum: 347 }, { nmId: 102, sum: 8 }])]);
  } } };
  return { env, db };
}

test('real scheduled writer persists kopecks, including paid SKU with no sales', async () => {
  const { env, db } = integrationEnv();
  const result = await syncWbSalesToErp(env);
  assert.equal(result.error, null);
  assert.equal(result.rows_synced, 2);
  assert.deepEqual(db.prepare('SELECT base_sku,units_sold,ad_spend_rub FROM marketplace_sales_wb ORDER BY base_sku').all().map(r => ({ ...r })),
    [{ base_sku: 'de203aa', units_sold: 0, ad_spend_rub: 800 }, { base_sku: 'de209', units_sold: 1, ad_spend_rub: 34700 }]);
  db.close();
});

test('advertising failure keeps previous snapshot and marks actual job error', async () => {
  const { env, db } = integrationEnv(true);
  const result = await syncWbSalesToErp(env);
  assert.match(result.error, /HTTP 403/);
  assert.equal(db.prepare('SELECT ad_spend_rub FROM marketplace_sales_wb WHERE base_sku=?').get('old').ad_spend_rub, 12345);
  assert.equal(db.prepare('SELECT status FROM marketplace_sync_log').get().status, 'error');
  db.close();
});
