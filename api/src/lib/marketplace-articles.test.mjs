import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as timer from '../../../workers/_marketplace/marketplace-articles.mjs';

const require = createRequire(import.meta.url), { build } = require('esbuild');
const folder = mkdtempSync(join(tmpdir(), 'marketplace-articles-'));
await build({ entryPoints: [fileURLToPath(new URL('./marketplace-articles.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: join(folder, 'articles.mjs') });
const api = await import(pathToFileURL(join(folder, 'articles.mjs')));
test.after(() => rmSync(folder, { recursive: true, force: true }));

test('Owner-confirmed DE201A maps to one tube only in the Ozon parser', () => {
  for (const parser of [api, timer]) for (const article of ['DE201A', 'de201a', ' DE201A ']) {
    assert.deepEqual(parser.parseOzonArticle(article), { baseSku: 'de201', packFactor: 1 });
    assert.deepEqual(parser.parseMarketplaceArticle(article), { baseSku: null, packFactor: 1 });
  }
});

test('legacy alias does not generalize the suffix or change valid pack sizes', () => {
  const cases = [[null,null,1],['',null,1],['DE201','de201',1],['DE201AA','de201',2],
    ['DE201AAAA','de201',4],['DE202A',null,1],['DE201AAA',null,1],['DE201A-extra',null,1]];
  for (const [article, baseSku, packFactor] of cases) for (const parser of [api, timer]) {
    assert.deepEqual(parser.parseOzonArticle(article), { baseSku, packFactor });
    assert.deepEqual(parser.parseMarketplaceArticle(article), { baseSku, packFactor });
  }
});

test('stock endpoint merges the legacy single tube without merging double packs', async () => {
  const { spawnSync } = await import('node:child_process');
  const routeFile = join(folder, 'marketplaces.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../routes/marketplaces.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile: routeFile });
  const { default: route } = await import(pathToFileURL(routeFile));
  const env = { DB: { prepare(sql) { return { async all() {
    const result = spawnSync('python3', ['-c', `
import sqlite3,json,sys
c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.executescript('''
CREATE TABLE products(id TEXT,deleted_at INTEGER);
INSERT INTO products VALUES('de201',NULL),('de201aa',NULL);
CREATE TABLE marketplace_stocks_ozon(offer_id TEXT,fbo_available INTEGER,fbo_reserved INTEGER,synced_at INTEGER);
INSERT INTO marketplace_stocks_ozon VALUES('DE201',5,2,100),('DE201A',7,1,200),('DE201AA',9,2,150);
CREATE TABLE marketplace_stocks_wb(supplier_article TEXT,quantity INTEGER,synced_at INTEGER);
INSERT INTO marketplace_stocks_wb VALUES('DE201',4,150);
''')
print(json.dumps([dict(r) for r in c.execute(sys.stdin.read())]))
`], { input: sql, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { results: JSON.parse(result.stdout) };
  } }; } } };
  const response = await route.request('/stocks', {}, env);
  assert.equal(response.status, 200);
  const { result } = await response.json();
  assert.deepEqual(result.stocks, [
    { base_sku: 'de201', ozon_units: 9, ozon_reserved: 3, wb_units: 4, ozon_synced_at: 200, wb_synced_at: 150 },
    { base_sku: 'de201aa', ozon_units: 7, ozon_reserved: 2, wb_units: 0, ozon_synced_at: 150, wb_synced_at: null },
  ]);
});
