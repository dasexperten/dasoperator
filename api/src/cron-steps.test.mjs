import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'ugc-cron-'));
const outfile = join(dir, 'steps.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./cron-steps.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'no-external-effects', setup(b) {
    b.onResolve({ filter: /^\./ }, a => a.importer.endsWith('cron-steps.ts') && a.path !== './lib/adaptive-runner' ? { path: a.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      const call = name => globalThis.__ugcCron.call(name);
      export const cronPollPerfReports=()=>call('unused');
      export const runPromoRefillSweep=()=>call('refill');
      export const detectDianaMessages=()=>call('detect');
      export const startDailyVideoReminders=()=>call('video_batch');
      export const igDmWatch=()=>call('read'), igDmHasNew=()=>call('probe'), igDmReply=()=>call('reply');
      export const ingestCreatorPayouts=()=>call('intake');
      export const ugcPayoutSweep=()=>call('payout'), ugcPayoutEvening=()=>call('unused');
      export const captureDmLinks=()=>call('links'), refreshContentMetrics=()=>call('content');
    ` }));
  } }] });
const { STEPS } = await import(pathToFileURL(outfile)); rmSync(dir, { recursive: true });

function fixture(t, overrides = {}, initial = null) {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const f = { state: initial ? JSON.stringify(initial) : null, calls: [], result: {
    read: { ok: true, activity: false, stored: 0, incoming: 0 }, reply: { replied: 0, escalated: 0, errors: 0 },
    probe: false, video_batch: {due:false}, payout: 0, incidents: undefined, links: { added: 0 }, content: { read: 0, removed: 0 }, ...overrides
  }, async call(name) { f.calls.push(name); const value = f.result[name]; if (value instanceof Error) throw value; return value; } };
  f.env = { DB: { prepare(sql) { let p; const q = {
    bind(...values) { p = values; return q; },
    async first() { if (sql.includes('COUNT(*)') && f.result.countFailure) throw f.result.countFailure; return sql.includes('COUNT(*)') ? { n: 0 } : f.state ? { value: f.state } : null; },
    async run() { f.state = p[1]; return { meta: { changes: 1 } }; }
  }; return q; } } };
  globalThis.__ugcCron = f; return f;
}
async function failsOnPayoutClock(t, worker, overrides, pattern) {
  const f = fixture(t, overrides); await assert.rejects(STEPS[worker](f.env), pattern);
  const s = JSON.parse(f.state); assert.equal(s.delay_min, 10); assert.equal(s.next_at, (Math.floor(Date.now() / 600_000) + 1) * 600_000);
  return f;
}
test('Direct only detects metadata; it never reads bodies, calls a reply model or changes adaptive cadence', async t => {
  const f = fixture(t, { detect: { detected: 3, dispatched: true } });
  assert.deepEqual(JSON.parse(await STEPS['erp-ugc-direct'](f.env)), { detected: 3, dispatched: true, video_reminder_batch: {due:false} });
  assert.deepEqual(f.calls, ['video_batch', 'detect']); assert.equal(f.state, null);
  const g = fixture(t, { detect: new Error('metadata unavailable') });
  await assert.rejects(STEPS['erp-ugc-direct'](g.env), /metadata unavailable/);
  assert.deepEqual(g.calls, ['video_batch', 'detect']);
});
test('payout timer ingests originals before sweeping payouts without legacy incident escalation, creator links or metrics', async t => {
  const f = fixture(t); await STEPS['erp-ugc-payouts'](f.env);
  assert.deepEqual(f.calls, ['intake', 'payout']);
});
test('payout idle is success; sweep exception is failure', async t => {
  const f = fixture(t); assert.match(await STEPS['erp-ugc-payouts'](f.env), /"ok":true/); assert.equal(JSON.parse(f.state).delay_min, 10);
  await failsOnPayoutClock(t, 'erp-ugc-payouts', { payout: new Error('Konsol unavailable') }, /Konsol unavailable/);
});
test('required waiting and payout count reads cannot report unknown as zero and succeed', async t => {
  await failsOnPayoutClock(t, 'erp-ugc-payouts', { countFailure: new Error('D1 read unavailable') }, /open payouts.*D1 read unavailable/);
});

test('removed timer jobs have no executable ERP step', () => {
  assert.equal(STEPS['erp-promo-refill'], undefined);
  assert.equal(STEPS['erp-ugc-payout-summary'], undefined);
});
