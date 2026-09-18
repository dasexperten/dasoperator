// node --test api/src/lib/cron-expect.test.mjs — the TS is compiled with esbuild for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// esbuild comes with wrangler — from the repo root or from workers/ (what CI installs).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const esbuildPath = createRequire(import.meta.url).resolve('esbuild', { paths: [root, join(root, 'workers')] });
const { transformSync } = await import(pathToFileURL(esbuildPath).href);

const ts = readFileSync(new URL('./cron-expect.ts', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'cron-'));
writeFileSync(join(dir, 'c.mjs'), transformSync(ts, { loader: 'ts', format: 'esm' }).code);
const { expectedFires } = await import(join(dir, 'c.mjs'));

const day = (iso) => [new Date(iso), new Date(new Date(iso).getTime() + 86400000)];
const n = (e, iso = '2026-09-17T00:00:00Z') => expectedFires(e, ...day(iso)).length;

test('daily, hourly, stepped', () => {
  assert.equal(n('0 12 * * *'), 1);
  assert.equal(n('15 * * * *'), 24);
  assert.equal(n('*/15 * * * *'), 96);
  assert.equal(n('*/2 * * * *'), 720);
  assert.equal(n('0 */4 * * *'), 6);
  assert.equal(n('45 */3 * * *'), 8);
});

test('lists and ranges', () => {
  assert.equal(n('7,22,37,52 * * * *'), 96);
  assert.equal(n('0 0,4,10,12,16,20 * * *'), 6);
  assert.equal(n('*/5 4-19 * * *'), 192);
});

test('day of week and month', () => {
  // 2026-09-17 is a Thursday, 2026-09-14 a Monday
  assert.equal(n('0 4 * * 4', '2026-09-17T00:00:00Z'), 1);
  assert.equal(n('0 4 * * 4', '2026-09-16T00:00:00Z'), 0);
  assert.equal(n('6 20 * * 1', '2026-09-14T00:00:00Z'), 1);
  assert.equal(n('0 3 5 * *', '2026-09-05T00:00:00Z'), 1);
  assert.equal(n('0 3 5 * *', '2026-09-06T00:00:00Z'), 0);
  // both day fields restricted → either matches: day 1-7 OR Wednesday
  assert.equal(n('0 4 1-7 * 3', '2026-09-16T00:00:00Z'), 1, 'a Wednesday on the 16th');
  assert.equal(n('0 4 1-7 * 3', '2026-09-03T00:00:00Z'), 1, 'the 3rd');
  assert.equal(n('0 4 1-7 * 3', '2026-09-18T00:00:00Z'), 0);
});
