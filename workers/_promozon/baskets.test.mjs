import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [process.cwd() + '/api'] }));
const dir = mkdtempSync(join(tmpdir(), 'ozon-baskets-'));
await build({ entryPoints: [fileURLToPath(new URL('./baskets.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'baskets.mjs') });
const { basketDays, readDailyBaskets, loadDailyBaskets } = await import(pathToFileURL(join(dir, 'baskets.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const at = Date.parse('2026-11-09T10:00:00Z');
const line = (sku, date, n) => ({ dimensions: [{ id: String(sku) }, { id: date }], metrics: [n] });
const map = new Map([['100', 1], ['101', 1], ['200', 2], ['300', 3]]);
const rows = [line(100, '2026-11-08', 7), line(101, '2026-11-08', 2), line(100, '2026-11-07', 12), line(200, '2026-11-07', 5)];
test('calendar uses Moscow midnight, not UTC or the Yerevan order cutoff', () => {
  assert.equal(basketDays(Date.parse('2026-11-08T20:30:00Z')).yesterday, '2026-11-07');
  assert.equal(basketDays(Date.parse('2026-11-08T21:00:00Z')).yesterday, '2026-11-08');
});
test('basket additions join exact source SKUs, dedupe map entries and preserve pack variants', async () => {
  let sent;
  const r = await readDailyBaskets(async (path, body) => { assert.equal(path, '/v1/analytics/data'); sent = body; return { result: { data: rows } }; }, map, [1, 2, 3, 4], at);
  assert.deepEqual(sent.dimension, ['sku', 'day']); assert.deepEqual(sent.metrics, ['hits_tocart']);
  assert.equal(sent.date_from, '2026-11-07'); assert.equal(sent.date_to, '2026-11-08');
  assert.deepEqual(r.by_product['1'], { yesterday: 9, day_before_yesterday: 12 });
  assert.deepEqual(r.by_product['2'], { yesterday: 0, day_before_yesterday: 5 });
  assert.deepEqual(r.by_product['3'], { yesterday: 0, day_before_yesterday: 0 });
  assert.equal(r.by_product['4'], undefined); assert.deepEqual(r.coverage.unmapped_products, [4]);
});
test('a wholly absent yesterday stays unknown even though the day before is real', async () => {
  const r = await readDailyBaskets(async () => ({ result: { data: [line(100, '2026-11-07', 12)] } }), map, [1, 2], at);
  assert.equal(r.by_product['1'].yesterday, null); assert.equal(r.by_product['1'].day_before_yesterday, 12);
});
test('historical zero rows do not blank valid baskets, while nonzero aliases require exact product-info SKU lookup', async () => {
  const called = [];
  const r = await readDailyBaskets(async (path, body) => {
    called.push([path, body]);
    return path === '/v1/analytics/data' ? { result: { data: [...rows, line(999, '2026-11-08', 0), line(888, '2026-11-07', 2)] } }
      : { items: [{ id: 2, offer_id: 'DE202' }] };
  }, new Map(map), [1, 2, 3], at, new Map([[1, 'DE202AA'], [2, 'DE202']]));
  assert.deepEqual(called[1], ['/v3/product/info/list', { sku: ['888'] }]);
  assert.equal(r.by_product['2'].day_before_yesterday, 7);
  assert.deepEqual(r.coverage.ignored_zero_unmapped_skus, ['999']);
  assert.deepEqual(r.coverage.resolved_source_skus, ['888']);
  await assert.rejects(readDailyBaskets(async path => path === '/v1/analytics/data'
    ? { result: { data: [line(888, '2026-11-08', 2)] } } : { items: [{ id: 2, offer_id: 'WRONG-PACK' }] },
    new Map(map), [1, 2], at, new Map([[2, 'DE202']])));
});
test('invalid, duplicate, unmapped or truncated analytics never becomes a complete numeric snapshot', async () => {
  for (const bad of [
    [],
    [line(999, '2026-11-08', 3)], [line(100, '2026-11-08', null)],
    [line(100, '2026-11-08', 1), line(100, '2026-11-08', 1)],
    [line(100, '2026-11-06', 3)], Array.from({ length: 1000 }, () => line(100, '2026-11-08', 1)),
  ]) await assert.rejects(readDailyBaskets(async () => ({ result: { data: bad } }), map, [1, 2], at));
  await assert.rejects(readDailyBaskets(async () => ({ error: 'no access' }), map, [1, 2], at));
});
let seq = 0;
function database() {
  const path = join(dir, `cache-${seq++}.sqlite`);
  function sql(query, params = []) {
    const p = spawnSync('python3', ['-c', `import sqlite3,json,sys
q,p=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
c.execute('CREATE TABLE IF NOT EXISTS crm_sync_state (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)')
r=[dict(x) for x in c.execute(q,p).fetchall()];c.commit();print(json.dumps(r))`, path], { input: JSON.stringify([query, params]), encoding: 'utf8' });
    if (p.status) throw Error(p.stderr); return JSON.parse(p.stdout);
  }
  return { prepare(query) { let params = []; return { bind(...p) { params = p; return this; }, async first() { return sql(query, params)[0] ?? null; }, async run() { sql(query, params); return {}; } }; } };
}
test('timer and interactive refresh share a real SQLite one-minute claim; failed refresh retains dated last good data', async () => {
  const db = database(); let calls = 0;
  const request = async () => { calls++; return { result: { data: rows } }; };
  const first = await loadDailyBaskets(db, request, map, [1, 2], at);
  assert.equal(first.snapshot.by_product['1'].yesterday, 9);
  const reused = await loadDailyBaskets(db, request, map, [1, 2], at + 30000);
  assert.equal(calls, 1); assert.equal(reused.stale, false);
  const failed = await loadDailyBaskets(db, async () => { calls++; throw Error('HTTP 429'); }, map, [1, 2], at + 60001);
  assert.equal(calls, 2); assert.equal(failed.stale, true); assert.equal(failed.snapshot.as_of, first.snapshot.as_of);
  const held = await loadDailyBaskets(db, request, map, [1, 2], at + 61000);
  assert.equal(calls, 2); assert.equal(held.stale, true);
});
test('a prior completed-day pair is not relabeled after Moscow midnight', async () => {
  const db = database();
  await loadDailyBaskets(db, async () => ({ result: { data: rows } }), map, [1, 2], at);
  const failed = await loadDailyBaskets(db, async () => { throw Error('source unavailable'); }, map, [1, 2], at + 86400000);
  assert.equal(failed.snapshot, null);
});
