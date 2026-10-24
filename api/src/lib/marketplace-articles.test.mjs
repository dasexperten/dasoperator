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
