import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'erp-stock-source-'));
const outfile = join(dir, 'route.mjs');
buildSync({ entryPoints: [fileURLToPath(new URL('./external-stocks.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { default: app } = await import(pathToFileURL(outfile));
const snapshot = [{ warehouse_id: 'lbr', product_id: 'de112', amount: 28122 }, { warehouse_id: 'other', product_id: 'de112', amount: 50 }];
function env(ids) {
  const trace = [];
  return { trace, INTERNAL_STOCK_WAREHOUSES: ids, DB: { prepare(sql) {
    let params = [];
    const stmt = { bind(...args) { params = args; return stmt; }, async all() {
      trace.push({ sql, params });
      return { results: sql.includes('NOT IN') ? snapshot.filter((r) => !params.includes(r.warehouse_id)) : snapshot };
    } }; return stmt;
  } } };
}
test('manual ERP warehouse is excluded from primary external stocks; raw F4 remains readable', async () => {
  const e = env(' lbr ');
  const primary = await (await app.request('/by-product', {}, e)).json();
  assert.deepEqual(primary.result.rows, [snapshot[1]]);
  assert.deepEqual(primary.result.internal_warehouse_ids, ['lbr']);
  const raw = await (await app.request('/', {}, e)).json();
  assert.deepEqual(raw.result.stocks, snapshot);
  assert.ok(e.trace.every(({sql}) => !/\b(UPDATE|INSERT|DELETE)\b/.test(sql)));
});
test('warehouses without a manual override retain external stocks', async () => {
  const e = env(undefined);
  const result = await (await app.request('/by-product', {}, e)).json();
  assert.deepEqual(result.result.rows, snapshot);
  assert.deepEqual(result.result.internal_warehouse_ids, []);
});
