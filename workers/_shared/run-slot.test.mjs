import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'erp-schedule-slot-'));
await build({ stdin: { contents: `export * from './run-slot'; export * from './run'; export * from './run-journal'; export * from './trigger-erp';`,
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'slots.mjs') });
const { slotRunKey, minuteSlot, currentHttpSlot, erpTriggerWorker, erpWorker, runLogged, runApiStep } = await import(pathToFileURL(join(dir, 'slots.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const workerName = 'erp-ugc-direct', cron = '* * * * *', now = Date.parse('2026-10-23T20:00:30Z'), slot = minuteSlot(now);
let seq = 0;
function fixture(t) {
  const dbPath = join(dir, `${seq++}.sqlite`);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  function sql(query, params = [], script = false) {
    const p = spawnSync('python3', ['-c', `import sqlite3,json,sys
q,p,s=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if s:c.executescript(q);r=[]
else:r=[dict(x) for x in c.execute(q,p).fetchall()]
n=c.execute('SELECT changes()').fetchone()[0];c.commit()
print(json.dumps({'success':True,'results':r,'meta':{'changes':n}}))`, dbPath], { input: JSON.stringify([query, params, script]), encoding: 'utf8' });
    if (p.status) throw Error(p.stderr);
    return JSON.parse(p.stdout);
  }
  for (const file of ['0091_erp_cron_runs.sql', '0137_erp_cron_run_key.sql', '0138_erp_cron_api_owner.sql', '0139_erp_cron_schedule_source.sql']) {
    sql(readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'), [], true);
  }
  const DB = { prepare(query) { let params = []; return { bind(...p) { params = p; return this; }, async run() { return sql(query, params); }, async first() { return sql(query, params).results[0] ?? null; } }; } };
  const f = { DB, sql, effects: 0, fetches: 0, beforeFetch: null, work: null };
  f.env = { DB, ERP_RUN_SECRET: 'fixture', ERP: { async fetch(url, opts) {
    f.fetches++;
    const headers = new Headers(opts.headers), source = headers.get('X-Erp-Trigger-Source');
    if (f.beforeFetch) await f.beforeFetch(f.fetches);
    const result = await runApiStep(DB, workerName, headers.get('X-Erp-Run-Key'), async () => {
      f.effects++;
      if (f.work) await f.work();
      return 'ig_dm: actual fixture work';
    }, () => {}, source);
    return Response.json({ ...result, ms: 1 }, { status: result.pending ? 409 : result.ok ? 200 : 500 });
  } } };
  f.worker = erpTriggerWorker(workerName);
  f.http = (body = { scheduledTime: slot }, secret = 'fixture', path = '/scheduled') => f.worker.fetch(new Request('https://test' + path,
    { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), f.env);
  f.cf = (time = now) => {
    let pending;
    f.worker.scheduled({ cron, scheduledTime: time, noRetry() {} }, f.env, { waitUntil(p) { pending = p; } });
    return pending;
  };
  return f;
}

test('same UTC slot has stable UUID across sub-minute timestamps and sources', async () => {
  assert.equal(await slotRunKey(workerName, cron, slot), await slotRunKey(workerName, cron, now));
  assert.match(await slotRunKey(workerName, cron, now), /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(await slotRunKey(workerName, cron, slot), await slotRunKey(workerName, cron, slot + 60_000));
  assert.notEqual(await slotRunKey(workerName, cron, slot), await slotRunKey('erp-ugc-payouts', cron, slot));
});

test('HTTP accepts only an integer timestamp for the current UTC minute', () => {
  assert.equal(currentHttpSlot({ scheduledTime: slot }, now), slot);
  for (const value of [null, [], {}, { scheduledTime: String(slot) }, { scheduledTime: slot - 60_000 },
    { scheduledTime: slot + 60_000 }, { scheduledTime: now }, { scheduledTime: Infinity }]) {
    assert.equal(currentHttpSlot(value, now), null);
  }
});

test('HTTP then CF and repeated HTTP execute once, preserve original source and slot', async t => {
  const f = fixture(t);
  assert.equal((await f.http()).status, 200);
  await f.cf();
  assert.equal((await f.http()).status, 200);
  assert.equal(f.effects, 1); assert.equal(f.fetches, 1);
  const rows = f.sql('SELECT scheduled_time,trigger_source,api_trigger_source,ok FROM erp_cron_runs').results;
  assert.deepEqual(rows, [{ scheduled_time: slot, trigger_source: 'external_clock', api_trigger_source: 'external_clock', ok: 1 }]);
});

test('simultaneous CF ownership makes HTTP pending without duplicate effects', async t => {
  const f = fixture(t); let release, entered;
  const started = new Promise(r => entered = r), held = new Promise(r => release = r);
  f.work = async () => { entered(); await held; };
  const cf = f.cf(); await started;
  const response = await f.http(); assert.equal(response.status, 409); assert.equal((await response.json()).apiPending, true);
  assert.equal(f.effects, 1); release(); await cf;
  assert.equal((await f.http()).status, 200); assert.equal(f.effects, 1);
  assert.equal(f.sql('SELECT api_trigger_source FROM erp_cron_runs').results[0].api_trigger_source, 'cloudflare');
});

test('fallback can take unclaimed CF row after caller loss, with auditable winning source', async t => {
  const f = fixture(t); let release, entered;
  const started = new Promise(r => entered = r), held = new Promise(r => release = r);
  f.beforeFetch = async attempt => { if (attempt === 1) { entered(); await held; throw Error('caller disconnected before API claim'); } };
  const cf = f.cf(); await started;
  assert.equal((await f.http()).status, 200);
  release(); await cf; // The API's persisted result wins over the lost first transport.
  assert.equal(f.effects, 1);
  assert.deepEqual(f.sql('SELECT trigger_source,api_trigger_source,ok FROM erp_cron_runs').results,
    [{ trigger_source: 'cloudflare', api_trigger_source: 'external_clock', ok: 1 }]);
});

test('concurrent pre-claim transports do not label the duplicate409 as a transport failure', async t => {
  const f = fixture(t); let firstEntered, releaseFirst, workEntered, releaseWork;
  const firstReady = new Promise(r => firstEntered = r), firstHeld = new Promise(r => releaseFirst = r);
  const workReady = new Promise(r => workEntered = r), workHeld = new Promise(r => releaseWork = r);
  f.beforeFetch = async attempt => { if (attempt === 1) { firstEntered(); await firstHeld; } };
  f.work = async () => { workEntered(); await workHeld; };
  const cf = f.cf(); await firstReady;
  const http = f.http(); await workReady;
  const rejected = assert.rejects(cf, /completion not yet confirmed/);
  releaseFirst(); await rejected;
  assert.equal(f.sql('SELECT transport_error FROM erp_cron_runs').results[0].transport_error, null);
  releaseWork(); assert.equal((await http).status, 200); assert.equal(f.effects, 1);
});

test('late CF delivery cannot run historical work or create a phantom success journal', async t => {
  const f = fixture(t); await f.cf(slot - 60_000);
  assert.equal(f.effects, 0); assert.equal(f.sql('SELECT count(*) n FROM erp_cron_runs').results[0].n, 0);
  const key = await slotRunKey(workerName, cron, slot - 60_000);
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at) VALUES(?,?,?,?)', [key, workerName, cron, 'earlier']);
  await f.cf(slot - 60_000); assert.equal(f.effects, 0);
  assert.equal(f.sql('SELECT finished_at FROM erp_cron_runs').results[0].finished_at, null);
});

test('late duplicate returns the historical confirmed result without replay', async t => {
  const f = fixture(t), old = slot - 60_000, key = await slotRunKey(workerName, cron, old);
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at,finished_at,ok,note) VALUES(?,?,?,?,?,?,?)', [key, workerName, cron, 'start', 'finish', 1, 'actual earlier result']);
  await f.cf(old); assert.equal(f.effects, 0); assert.equal(f.fetches, 0);
});

test('unauthorized, stale and future HTTP requests never touch business work', async t => {
  const f = fixture(t);
  assert.equal((await f.http({}, 'wrong')).status, 401);
  for (const time of [slot - 60_000, slot + 60_000, now]) assert.equal((await f.http({ scheduledTime: time })).status, 400);
  assert.equal(f.effects, 0); assert.equal(f.sql('SELECT count(*) n FROM erp_cron_runs').results[0].n, 0);
});

test('HTTP scheduled door is unavailable for self-contained workers; manual runs remain distinct', async t => {
  const f = fixture(t); let jobs = 0;
  const other = erpWorker('erp-self-contained', async () => { jobs++; return { note: 'manual fixture' }; });
  const request = path => new Request('https://test' + path, { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: JSON.stringify({ scheduledTime: slot }) });
  assert.equal((await other.fetch(request('/scheduled'), f.env)).status, 404);
  for (let i = 0; i < 2; i++) assert.equal((await other.fetch(request('/run'), f.env)).status, 200);
  assert.equal(jobs, 2);
  const rows = f.sql('SELECT run_key,scheduled_time,trigger_source FROM erp_cron_runs').results;
  assert.notEqual(rows[0].run_key, rows[1].run_key);
  assert.ok(rows.every(row => row.scheduled_time === null && row.trigger_source === 'manual'));
});
