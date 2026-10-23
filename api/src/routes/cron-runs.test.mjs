import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'erp-guard-route-'));
await build({ entryPoints: [fileURLToPath(new URL('./cron-runs.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs') });
const { default: route } = await import(pathToFileURL(join(dir, 'route.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
async function guard(t, at, rows = []) {
  t.mock.method(Date, 'now', () => Date.parse(at));
  const DB = { prepare() { return { bind() { return this; }, async all() { return { results: rows }; } }; } };
  const r = await route.request('/guard?hours=24', {}, { DB });
  assert.equal(r.status, 200);
  return (await r.json()).result.workers;
}
const find = (rows, name = 'erp-site-sales-rebuild') => rows.find(r => r.worker === name);
function receipt(worker, at, { ok = 1, note = 'actual work', finished = true, dry = 0 } = {}) {
  return { worker, cron: worker === 'erp-site-sales-rebuild' ? '0 4 * * 4' : '* * * * *', started_at: at,
    finished_at: finished ? at : null, ok, dry_run: dry, note, error: ok ? null : 'fixture failure' };
}
test('second Wednesday missed nominal CF wakeup is quiet because no rebuild is due', async t => {
  const r = find(await guard(t, '2026-11-11T06:20:00Z'));
  assert.equal(r.transport_expected, 1); assert.equal(r.expected, 0); assert.equal(r.missed, 0); assert.equal(r.verdict, 'quiet');
});
test('first Wednesday genuine missing rebuild remains red', async t => {
  const r = find(await guard(t, '2026-11-04T06:20:00Z'));
  assert.equal(r.transport_expected, 1); assert.equal(r.expected, 1); assert.equal(r.missed, 1); assert.equal(r.verdict, 'red');
});
test('later Wednesday not-due receipt proves transport only, never actual work or recovery', async t => {
  const r = find(await guard(t, '2026-11-11T06:20:00Z', [receipt('erp-site-sales-rebuild', '2026-11-11T04:00:00Z',
    { note: 'site_sales_rebuild: not due (SKIPPED — first Wednesday only)' })]));
  assert.equal(r.ran, 1); assert.equal(r.journal_ok, 1); assert.equal(r.work_ok, 0); assert.equal(r.idle, 1);
  assert.equal(r.last_ok, null); assert.equal(r.verdict, 'quiet');
});
test('business failure is not recovered by not-due, running, held-lease, dry or unfinished receipts', async t => {
  const name = 'erp-ugc-direct', notes = ['ig_dm: not due', 'ig_dm: taken by another run', 'ig_dm: running',
    'SKIPPED — WB sync already running'];
  for (const note of notes) {
    const r = find(await guard(t, '2026-11-11T06:20:00Z', [receipt(name, '2026-11-11T04:00:00Z', { ok: 0 }),
      receipt(name, '2026-11-11T04:05:00Z', { note })]), name);
    assert.equal(r.recovered, false, note); assert.equal(r.work_ok, 0, note); assert.equal(r.last_ok, null, note); assert.equal(r.verdict, 'red');
  }
  for (const opts of [{ dry: 1 }, { finished: false }]) {
    const r = find(await guard(t, '2026-11-11T06:20:00Z', [receipt(name, '2026-11-11T04:00:00Z', { ok: 0 }),
      receipt(name, '2026-11-11T04:05:00Z', opts)]), name);
    assert.equal(r.recovered, false); assert.equal(r.last_ok, null);
  }
});
test('a completed genuine later business pass can recover a recorded failure', async t => {
  const name = 'erp-site-sales-rebuild';
  const r = find(await guard(t, '2026-11-04T06:20:00Z', [receipt(name, '2026-11-04T04:00:00Z', { ok: 0 }),
    receipt(name, '2026-11-04T04:05:00Z')]));
  assert.equal(r.recovered, true); assert.equal(r.failed, 1); assert.equal(r.work_ok, 1); assert.equal(r.verdict, 'yellow');
});
test('real failures stay red even on a calendar date when no work was expected', async t => {
  const r = find(await guard(t, '2026-11-11T06:20:00Z', [receipt('erp-site-sales-rebuild', '2026-11-11T04:00:00Z', { ok: 0 })]));
  assert.equal(r.expected, 0); assert.equal(r.failed, 1); assert.equal(r.verdict, 'red');
});

test('healthy adaptive idle ticks stay green transport without claiming business work', async t => {
  const name = 'erp-ugc-direct', start = Date.parse('2026-11-10T06:00:00Z');
  const rows = Array.from({ length: 1440 }, (_, i) => receipt(name, new Date(start + i * 60_000).toISOString(), { note: 'ig_dm: not due' }));
  const r = find(await guard(t, '2026-11-11T06:20:00Z', rows), name);
  assert.equal(r.expected, 1440); assert.equal(r.journal_ok, 1440); assert.equal(r.idle, 1440);
  assert.equal(r.work_ok, 0); assert.equal(r.last_ok, null); assert.equal(r.verdict, 'green');
});

test('first Wednesday idle receipt cannot stand in for a required actual rebuild', async t => {
  const r = find(await guard(t, '2026-11-04T06:20:00Z', [receipt('erp-site-sales-rebuild', '2026-11-04T04:00:00Z',
    { note: 'site_sales_rebuild: not due' })]));
  assert.equal(r.expected, 1); assert.equal(r.transport_missed, 0); assert.equal(r.work_ok, 0);
  assert.equal(r.missed, 1); assert.equal(r.verdict, 'red');
});
