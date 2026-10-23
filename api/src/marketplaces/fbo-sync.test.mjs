import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'ozon-fbo-'));
const outfile = join(dir, 'fbo.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./fbo-sync.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { syncOzonFboSalesOnly } = await import(pathToFileURL(outfile)); rmSync(dir, { recursive: true });

const posting = (offer_id, quantity, date, warehouse = 'MOSCOW', status = 'delivered') => ({ status, created_at: date, analytics_data: { warehouse_name: warehouse }, products: [{ offer_id, quantity }] });
function fixture(t, pages) {
  const f = { calls: [], batches: [] };
  t.mock.method(Date, 'now', () => Date.parse('2026-10-23T10:00:00Z'));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/v1/cluster/list')) return Response.json({ clusters: [] });
    assert.match(url, /^https:\/\/api-seller\.ozon\.ru\/v[23]\/posting\/fbo\/list$/);
    f.calls.push({ url, body: JSON.parse(init.body) });
    const page = typeof pages === 'function' ? pages(f.calls.length) : pages[f.calls.length - 1];
    assert.ok(page, 'unexpected page request');
    return page instanceof Response ? page : Response.json(page);
  });
  const statement = (sql, args = []) => ({ sql, args, bind(...p) { return statement(sql, p); }, async all() {
    assert.match(sql, /SELECT warehouse_name, cluster FROM fbo_cluster_map/);
    return { results: [{ warehouse_name: 'MOSCOW', cluster: 'Center' }] };
  } });
  f.env = { OZON_CLIENT_ID: 'fixture-only', OZON_API_KEY: 'fixture-only', DB: {
    prepare: statement, async batch(statements) { f.batches.push(statements); return statements.map(() => ({ meta: { changes: 1 } })); }
  } };
  f.snapshots = () => f.batches.filter(batch => batch.some(s => s.sql.startsWith('DELETE FROM fbo_sales_cluster')));
  return f;
}
test('v3 follows has_next/cursor even for short pages and preserves totals, cancellation, SKU normalization and dates', async t => {
  const first = posting('DE-101', 2, '2026-10-01T12:00:00Z'); first.products.push({ offer_id: '', quantity: 90 });
  const later = posting('de_101', 3, undefined); later.in_process_at = '2026-10-20T12:00:00Z';
  const f = fixture(t, [
    { postings: [first, posting('DE-101', 900, '2026-10-22T00:00:00Z', 'MOSCOW', 'cancelled')], has_next: true, cursor: 'next-1' },
    { postings: [later, posting('DE 102', 1, '2026-10-03T12:00:00Z', 'UNMAPPED')], has_next: false, cursor: '' }
  ]);
  assert.deepEqual(await syncOzonFboSalesOnly(f.env), { sales: 2, unknown_warehouses: 1 });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.url.endsWith('/v3/posting/fbo/list')); assert.equal(c.body.offset, undefined); assert.equal(c.body.limit, 1000);
    assert.deepEqual(c.body.filter, { since: '2026-09-23T00:00:00Z', to: '2026-10-23T23:59:59Z' });
    assert.deepEqual(c.body.with, { analytics_data: true, financial_data: false });
  }
  assert.equal(f.calls[0].body.cursor, ''); assert.equal(f.calls[1].body.cursor, 'next-1');
  const snapshot = f.snapshots(); assert.equal(snapshot.length, 1);
  const inserted = snapshot[0].filter(s => s.sql.startsWith('INSERT INTO fbo_sales_cluster')).flatMap(s => s.args);
  assert.deepEqual(inserted.slice(0, 8), ['ozon', 'de101', 'Center', 5, '2026-09-23', '2026-10-23', '2026-10-01', '2026-10-20']);
  assert.deepEqual(inserted.slice(9, 17), ['ozon', 'de102', 'UNKNOWN', 1, '2026-09-23', '2026-10-23', '2026-10-03', '2026-10-03']);
});
test('a failure on a later page never writes a partial sales snapshot', async t => {
  const f = fixture(t, [{ postings: [posting('DE101', 2, '2026-10-01')], has_next: true, cursor: 'next' }, Response.json({ error: 'bad request' }, { status: 400 })]);
  await assert.rejects(syncOzonFboSalesOnly(f.env), /HTTP 400/); assert.equal(f.snapshots().length, 0);
});
test('missing, repeated and cyclic cursors fail before replacing the snapshot', async t => {
  for (const cursors of [[''], ['same', 'same'], ['first', 'second', 'first']]) {
    const f = fixture(t, cursors.map(cursor => ({ postings: [posting('DE101', 1, '2026-10-01')], has_next: true, cursor })));
    await assert.rejects(syncOzonFboSalesOnly(f.env), /cursor/); assert.equal(f.snapshots().length, 0);
  }
});
test('forty pages with more data remaining fail explicitly instead of publishing partial totals', async t => {
  const f = fixture(t, n => ({ postings: [posting('DE101', 1, '2026-10-01')], has_next: true, cursor: 'page-' + n }));
  await assert.rejects(syncOzonFboSalesOnly(f.env), /40 pages/); assert.equal(f.calls.length, 40); assert.equal(f.snapshots().length, 0);
});
test('malformed response cannot erase existing sales; an explicit empty terminal page can', async t => {
  for (const invalid of [{ result: [] }, { postings: [], has_next: 'false' }, { has_next: false }]) {
    const f = fixture(t, [invalid]); await assert.rejects(syncOzonFboSalesOnly(f.env), /response shape/); assert.equal(f.snapshots().length, 0);
  }
  const f = fixture(t, [{ postings: [], has_next: false, cursor: '' }]);
  assert.deepEqual(await syncOzonFboSalesOnly(f.env), { sales: 0, unknown_warehouses: 0 }); assert.equal(f.snapshots().length, 1);
});
