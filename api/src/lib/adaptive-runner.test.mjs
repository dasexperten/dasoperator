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
const dir = mkdtempSync(join(tmpdir(), 'adaptive-runner-'));
const outfile = join(dir, 'runner.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./adaptive-runner.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { runAdaptiveLane } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

function fixture(t, state = null) {
  const f = { now: 1_000_000, value: state ? JSON.stringify(state) : null, timer: null, clears: 0, renewals: 0 };
  t.mock.method(Date, 'now', () => f.now);
  t.mock.method(globalThis, 'setInterval', (fn) => { f.timer = fn; return 77; });
  t.mock.method(globalThis, 'clearInterval', () => { f.clears++; });
  f.env = { DB: { prepare(sql) {
    let args;
    const q = { bind(...values) { args = values; return q; },
      async first() { return f.value ? { value: f.value } : null; },
      async run() {
        if (sql.includes('json_set')) {
          const current = JSON.parse(f.value ?? '{}');
          if (current.lease_token !== args[3]) return { meta: { changes: 0 } };
          f.value = JSON.stringify({ ...current, lease_until: args[1], next_at: args[1] });
          f.renewals++;
        } else if (sql.startsWith('UPDATE')) {
          const owns = sql.includes('lease_token') ? JSON.parse(f.value ?? '{}').lease_token === args[3] : f.value === args[3];
          if (!owns) return { meta: { changes: 0 } };
          f.value = args[1];
        } else if (sql.includes('ON CONFLICT(key) DO NOTHING')) {
          if (f.value) return { meta: { changes: 0 } };
          f.value = args[1];
        } else if (sql.includes('INSERT INTO crm_sync_state')) f.value = args[1];
        else throw Error('unexpected SQL ' + sql);
        return { meta: { changes: 1 } };
      }
    }; return q;
  } } };
  return f;
}

test('a legacy heartbeat extended beyond five minutes blocks both probe and work', async t => {
  const f = fixture(t, { running_since: 600_000, next_at: 1_200_000 });
  let probes = 0, jobs = 0;
  await runAdaptiveLane(f.env, 'ig_dm', async () => { jobs++; return { ok: true, activity: true }; }, f.now, async () => { probes++; return true; });
  assert.equal(probes, 0); assert.equal(jobs, 0);
});

test('an active explicit lease blocks a due cadence and cannot be bypassed by a probe', async t => {
  const f = fixture(t, { running_since: 600_000, next_at: 900_000, lease_until: 1_200_000, lease_token: 'owner' });
  let probes = 0, jobs = 0;
  await runAdaptiveLane(f.env, 'ig_dm', async () => { jobs++; return { ok: true, activity: true }; }, f.now, async () => { probes++; return true; });
  assert.equal(probes, 0); assert.equal(jobs, 0);
});

test('an older completion cannot overwrite a successor lease', async t => {
  const f = fixture(t);
  const successor = { next_at: 2_000_000, running_since: 1_500_000, lease_until: 2_000_000, lease_token: 'successor' };
  await assert.rejects(runAdaptiveLane(f.env, 'ugc_payouts', async () => {
    f.value = JSON.stringify(successor);
    if (f.timer) await f.timer(); // An already scheduled heartbeat is stale too.
    assert.deepEqual(JSON.parse(f.value), successor);
    return { ok: true, activity: true };
  }, f.now), /lease no longer owned/);
  assert.deepEqual(JSON.parse(f.value), successor);
});

test('an expired lease can be reclaimed, preserving the idle cadence', async t => {
  const f = fixture(t, { running_since: 500_000, lease_until: 800_000, next_at: 800_000, lease_token: 'expired', idle: 1 });
  let jobs = 0;
  await runAdaptiveLane(f.env, 'ig_dm', async () => { jobs++; return { ok: true, activity: false }; }, f.now);
  assert.equal(jobs, 1); assert.equal(JSON.parse(f.value).delay_min, 30);
  assert.equal(JSON.parse(f.value).lease_token, undefined);
});

test('the runner renews throughout lane work and clears its timer; cadence begins on completion', async t => {
  const f = fixture(t);
  await runAdaptiveLane(f.env, 'ugc_payouts', async () => {
    assert.equal(typeof f.timer, 'function');
    for (let n = 0; n < 6; n++) { f.now += 60_000; await f.timer(); }
    let duplicate = 0;
    await runAdaptiveLane(f.env, 'ugc_payouts', async () => { duplicate++; return { ok: true, activity: true }; }, f.now);
    assert.equal(duplicate, 0);
    return { ok: true, activity: true };
  }, f.now);
  const state = JSON.parse(f.value);
  assert.equal(f.renewals, 6); assert.equal(f.clears, 1);
  assert.equal(state.next_at, f.now + 3 * 60_000); assert.equal(state.lease_token, undefined);
  assert.equal(state.last_ok, true);
  assert.equal(state.last_started_at, 1_000_000);
  assert.equal(state.last_finished_at, f.now);
  assert.equal(state.last_duration_ms, 360_000);
});

test('failure schedules three minutes after completion and clears the heartbeat', async t => {
  const f = fixture(t);
  await assert.rejects(runAdaptiveLane(f.env, 'ig_dm', async () => { f.now += 120_000; throw Error('upstream unavailable'); }, f.now), /upstream unavailable/);
  assert.equal(JSON.parse(f.value).next_at, f.now + 3 * 60_000);
  assert.equal(JSON.parse(f.value).last_ok, false);
  assert.equal(f.clears, 1);
});
