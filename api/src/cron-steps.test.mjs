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
      export const igDmWatch=()=>call('read'), igDmHasNew=()=>call('probe'), igDmReply=()=>call('reply');
      export const ugcPayoutSweep=()=>call('payout'), ugcPayoutEvening=()=>call('unused');
      export const incidentControl=()=>call('incidents'), captureDmLinks=()=>call('links'), refreshContentMetrics=()=>call('content');
    ` }));
  } }] });
const { STEPS } = await import(pathToFileURL(outfile)); rmSync(dir, { recursive: true });

function fixture(t, overrides = {}, initial = null) {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const f = { state: initial ? JSON.stringify(initial) : null, calls: [], result: {
    read: { ok: true, activity: false, stored: 0, incoming: 0 }, reply: { replied: 0, escalated: 0, errors: 0 },
    probe: false, payout: 0, incidents: undefined, links: { added: 0 }, content: { read: 0, removed: 0 }, ...overrides
  }, async call(name) { f.calls.push(name); const value = f.result[name]; if (value instanceof Error) throw value; return value; } };
  f.env = { DB: { prepare(sql) { let p; const q = {
    bind(...values) { p = values; return q; },
    async first() { if (sql.includes('COUNT(*)') && f.result.countFailure) throw f.result.countFailure; return sql.includes('COUNT(*)') ? { n: 0 } : f.state ? { value: f.state } : null; },
    async run() { f.state = p[1]; return { meta: { changes: 1 } }; }
  }; return q; } } };
  globalThis.__ugcCron = f; return f;
}
async function failsInThreeMinutes(t, worker, overrides, pattern) {
  const f = fixture(t, overrides); await assert.rejects(STEPS[worker](f.env), pattern);
  const s = JSON.parse(f.state); assert.equal(s.delay_min, 3); assert.equal(s.next_at, Date.now() + 180_000);
  return f;
}
test('Direct reported read failure remains failed even if an archived reply succeeds', async t => {
  await failsInThreeMinutes(t, 'erp-ugc-direct', { read: { ok: false, activity: true, stored: 2, incoming: 1, error: 'conversations unreadable' }, reply: { replied: 1, escalated: 0, errors: 0 } }, /conversations unreadable/);
});
test('Direct reply exception and partial processing failures fail the lane', async t => {
  await failsInThreeMinutes(t, 'erp-ugc-direct', { reply: new Error('provider unavailable') }, /reply.*provider unavailable/);
  await failsInThreeMinutes(t, 'erp-ugc-direct', { reply: { replied: 1, escalated: 0, errors: 2 } }, /reply.*2/);
});
test('Direct read exception is failed and never reaches the reply writer', async t => {
  const f = await failsInThreeMinutes(t, 'erp-ugc-direct', { read: new Error('D1 unavailable') }, /D1 unavailable/);
  assert.ok(!f.calls.includes('reply'));
});
test('ordinary review escalation, idle and not-due are successful', async t => {
  const f = fixture(t, { reply: { replied: 0, escalated: 1, errors: 0 } }); assert.match(await STEPS['erp-ugc-direct'](f.env), /"ok":true/);
  assert.equal(JSON.parse(f.state).delay_min, 15);
  const g = fixture(t, {}, { next_at: Date.now() + 60_000 }); assert.match(await STEPS['erp-ugc-direct'](g.env), /not due/); assert.ok(!g.calls.includes('read'));
});
test('payout link exception and content exception or partial error fail the lane', async t => {
  const f = await failsInThreeMinutes(t, 'erp-ugc-payouts', { links: new Error('link D1 failure') }, /links.*link D1 failure/);
  assert.ok(f.calls.includes('content'));
  await failsInThreeMinutes(t, 'erp-ugc-payouts', { content: new Error('browser unavailable') }, /content.*browser unavailable/);
  await failsInThreeMinutes(t, 'erp-ugc-payouts', { content: new Error('') }, /content.*Error/);
  await failsInThreeMinutes(t, 'erp-ugc-payouts', { content: { read: 2, removed: 1, error: 'browser partial failure' } }, /content.*browser partial failure/);
});
test('payout idle is success; sweep exception is failure', async t => {
  const f = fixture(t); assert.match(await STEPS['erp-ugc-payouts'](f.env), /"ok":true/); assert.equal(JSON.parse(f.state).delay_min, 15);
  await failsInThreeMinutes(t, 'erp-ugc-payouts', { payout: new Error('Konsol unavailable') }, /Konsol unavailable/);
});
test('required waiting and payout count reads cannot report unknown as zero and succeed', async t => {
  await failsInThreeMinutes(t, 'erp-ugc-direct', { countFailure: new Error('D1 read unavailable') }, /waiting replies.*D1 read unavailable/);
  await failsInThreeMinutes(t, 'erp-ugc-payouts', { countFailure: new Error('D1 read unavailable') }, /open payouts.*D1 read unavailable/);
});

test('promo refill errors are failures even when other rules succeeded', async t => {
  const f = fixture(t, { refill: { rules_checked: 36, refills_triggered: 1, errors: ['legacy control disabled'] } });
  await assert.rejects(STEPS['erp-promo-refill'](f.env), /promo refill: 1 errors; legacy control disabled/);
  const g = fixture(t, { refill: { rules_checked: 36, refills_triggered: 0, errors: [] } });
  assert.equal(JSON.parse(await STEPS['erp-promo-refill'](g.env)).rules_checked, 36);
});

test('host-budget deferred Direct work keeps the next adaptive tick in3minutes',async t=>{const f=fixture(t,{reply:{replied:0,escalated:0,errors:0,deferred:2}});const result=await STEPS['erp-ugc-direct'](f.env);assert.match(result,/deferred/);const state=JSON.parse(f.state);assert.equal(state.delay_min,3);});
