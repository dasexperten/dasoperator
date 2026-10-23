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
const { slotRunKey, minuteSlot, currentHttpSlot, currentHttpSchedule, dueScheduledSlot, hasScheduledDoor,
  isLocalScheduledWorker, erpTriggerWorker, erpWorker, runLogged, runApiStep, claimLocalRun, finishTimerRun } = await import(pathToFileURL(join(dir, 'slots.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const workerName = 'erp-ugc-direct', cron = '* * * * *', now = Date.parse('2026-10-23T20:00:30Z'), slot = minuteSlot(now);
let seq = 0;
function fixture(t, { name = workerName, at = now, failure = {} } = {}) {
  const dbPath = join(dir, `${seq++}.sqlite`);
  t.mock.method(Date, 'now', () => at);
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
  for (const file of ['0091_erp_cron_runs.sql', '0137_erp_cron_run_key.sql', '0138_erp_cron_api_owner.sql', '0139_erp_cron_schedule_source.sql', '0140_erp_cron_local_owner.sql']) {
    sql(readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'), [], true);
  }
  let failedWrites = 0;
  const DB = { prepare(query) { let params = []; return { bind(...p) { params = p; return this; }, async run() {
    const match = failure.match?.test(query) && failedWrites < (failure.times ?? 1);
    if (match && failure.before) { failedWrites++; throw Error('Network connection lost'); }
    const result = sql(query, params);
    if (match) { failedWrites++; throw Error('Network connection lost'); }
    return result;
  }, async first() { return sql(query, params).results[0] ?? null; } }; } };
  const f = { DB, sql, effects: 0, fetches: 0, noRetries: 0, beforeFetch: null, work: null };
  f.env = { DB, ERP_RUN_SECRET: 'fixture', ERP: { async fetch(url, opts) {
    f.fetches++;
    const headers = new Headers(opts.headers), source = headers.get('X-Erp-Trigger-Source');
    if (f.beforeFetch) await f.beforeFetch(f.fetches);
    const result = await runApiStep(DB, name, headers.get('X-Erp-Run-Key'), async () => {
      f.effects++;
      if (f.work) await f.work();
      return 'ig_dm: actual fixture work';
    }, () => {}, source);
    return Response.json({ ...result, ms: 1 }, { status: result.pending ? 409 : result.ok ? 200 : 500 });
  } } };
  f.worker = isLocalScheduledWorker(name) ? erpWorker(name, async () => {
    f.effects++; if (f.work) await f.work(); return { rows: 3, note: 'actual local fixture work' };
  }) : erpTriggerWorker(name);
  f.http = (body = { scheduledTime: minuteSlot(at) }, secret = 'fixture', path = '/scheduled') => f.worker.fetch(new Request('https://test' + path,
    { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), f.env);
  f.cf = (time = at, eventCron = cron) => {
    let pending;
    f.worker.scheduled({ cron: eventCron, scheduledTime: time, noRetry() { f.noRetries++; } }, f.env, { waitUntil(p) { pending = p; } });
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

test('HTTP scheduled door is unavailable for unregistered workers; manual runs remain distinct', async t => {
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

test('broader registry includes API-backed lanes but excludes disabled and retired work', () => {
  for (const name of ['erp-blogger-id', 'erp-mail-snapshot', 'erp-ozon-ads-poll', 'erp-ugc-payout-summary']) assert.equal(hasScheduledDoor(name), true);
  for (const name of ['erp-promo-refill', 'erp-promozon', 'erp-vn-einvoice', 'erp-fbo-sync']) assert.equal(hasScheduledDoor(name), false);
});

test('hourly HTTP requires exact configured cron and current due minute, then dedupes CF', async t => {
  const f = fixture(t, { name: 'erp-blogger-id' });
  assert.equal((await f.http()).status, 400); // Missing cron is backward compatible only for minute UGC lanes.
  assert.equal((await f.http({ scheduledTime: slot, cron })).status, 400);
  const scheduled = { scheduledTime: slot, cron: '0 * * * *' };
  assert.equal((await f.http(scheduled)).status, 200);
  await f.cf(now, scheduled.cron);
  assert.equal(f.effects, 1);
  assert.equal(f.sql('SELECT count(*) n FROM erp_cron_runs').results[0].n, 1);
  assert.equal(currentHttpSchedule('erp-blogger-id', { ...scheduled, scheduledTime: slot + 60_000 }, slot + 60_000), null);
});

test('CF rejects a wrong expression or non-due time for an enabled hourly worker', async t => {
  const f = fixture(t, { name: 'erp-blogger-id', at: now + 60_000 });
  await f.cf(now + 60_000, '0 * * * *');
  await f.cf(now + 60_000, '* * * * *');
  assert.equal(f.effects, 0); assert.equal(f.sql('SELECT count(*) n FROM erp_cron_runs').results[0].n, 0);
});

test('weekly registry keeps Cloudflare weekday numbering and monthly first-Wednesday gate', () => {
  const time = text => Date.parse(text);
  assert.equal(dueScheduledSlot('erp-wb-weekly-report', '0 4 * * 5', time('2026-10-22T04:00:00Z')), true);
  assert.equal(dueScheduledSlot('erp-wb-weekly-report', '0 4 * * 5', time('2026-10-21T04:00:00Z')), false);
  assert.equal(dueScheduledSlot('erp-site-sales-rebuild', '0 4 * * 4', time('2026-11-04T04:00:00Z')), true);
  for (const date of ['2026-11-11', '2026-11-03', '2026-11-05']) assert.equal(dueScheduledSlot('erp-site-sales-rebuild', '0 4 * * 4', time(date + 'T04:00:00Z')), false);
});

test('first Wednesday HTTP invokes rebuild once and its CF duplicate does no additional work', async t => {
  const at = Date.parse('2026-11-04T04:00:10Z'), f = fixture(t, { name: 'erp-site-sales-rebuild', at });
  assert.equal((await f.http({ scheduledTime: minuteSlot(at), cron: '0 4 * * 4' })).status, 200);
  await f.cf(at, '0 4 * * 4'); assert.equal(f.effects, 1);
});

test('later Wednesday HTTP is rejected and CF leaves a truthful not-due skip without ERP work', async t => {
  const at = Date.parse('2026-11-11T04:00:10Z'), f = fixture(t, { name: 'erp-site-sales-rebuild', at });
  assert.equal((await f.http({ scheduledTime: minuteSlot(at), cron: '0 4 * * 4' })).status, 400);
  await f.cf(at, '0 4 * * 4'); assert.equal(f.effects, 0); assert.equal(f.fetches, 0);
  const row = f.sql('SELECT ok,note,api_owner FROM erp_cron_runs').results[0];
  assert.equal(row.ok, 1); assert.match(row.note, /not due.*first Wednesday/); assert.equal(row.api_owner, null);
});

test('active API trigger missing its secret records a failure before transport, rather than a green skip', async t => {
  const f = fixture(t); delete f.env.ERP_RUN_SECRET;
  await assert.rejects(f.cf(), /ERP_RUN_SECRET missing/);
  assert.equal(f.effects, 0); assert.equal(f.fetches, 0);
  const row = f.sql('SELECT ok,error FROM erp_cron_runs').results[0];
  assert.equal(row.ok, 0); assert.match(row.error, /ERP_RUN_SECRET missing/);
});

test('explicit DRY_RUN remains successful without a key or API call', async t => {
  const f = fixture(t); delete f.env.ERP_RUN_SECRET; f.env.DRY_RUN = '1';
  await f.cf(); assert.equal(f.effects, 0); assert.equal(f.fetches, 0);
  const row = f.sql('SELECT ok,dry_run,note FROM erp_cron_runs').results[0];
  assert.equal(row.ok, 1); assert.equal(row.dry_run, 1); assert.match(row.note, /^dry/);
});

const localName = 'erp-partner-status', localCron = '0 12 * * *', localAt = Date.parse('2026-10-23T12:00:20Z');
const localBody = { scheduledTime: minuteSlot(localAt), cron: localCron };
test('local CF and external clock claim one effect with local-only provenance', async t => {
  const f = fixture(t, { name: localName, at: localAt }); let release, entered;
  const held = new Promise(r => release = r), started = new Promise(r => entered = r);
  f.work = async () => { entered(); await held; };
  const first = f.cf(localAt, localCron); await started;
  const duplicate = await f.http(localBody);
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).localPending, true);
  release(); await first;
  assert.equal((await f.http(localBody)).status, 200); assert.equal(f.effects, 1);
  const row = f.sql('SELECT local_owner,local_started_at,local_trigger_source,api_owner,api_trigger_source,ok FROM erp_cron_runs').results[0];
  assert.ok(row.local_owner); assert.ok(row.local_started_at); assert.equal(row.local_trigger_source, 'cloudflare');
  assert.equal(row.api_owner, null); assert.equal(row.api_trigger_source, null); assert.equal(row.ok, 1);
});

test('unclaimed slot inserted by CF can be executed by the local external transport', async t => {
  const f = fixture(t, { name: localName, at: localAt }), key = await slotRunKey(localName, localCron, localAt);
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at,trigger_source) VALUES(?,?,?,?,?)', [key, localName, localCron, new Date(localAt).toISOString(), 'cloudflare']);
  assert.equal((await f.http(localBody)).status, 200); assert.equal(f.effects, 1);
  assert.deepEqual(f.sql('SELECT trigger_source,local_trigger_source,api_owner FROM erp_cron_runs').results,
    [{ trigger_source: 'cloudflare', local_trigger_source: 'external_clock', api_owner: null }]);
});

test('canceled local owner is never reclaimed or finalized by a duplicate or API caller', async t => {
  const f = fixture(t, { name: localName, at: localAt }), key = await slotRunKey(localName, localCron, localAt);
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at) VALUES(?,?,?,?)', [key, localName, localCron, 'start']);
  const claim = await claimLocalRun(f.DB, localName, key, 'cloudflare', () => {});
  assert.equal(claim.state, 'claimed');
  // Simulate durable state after termination: an owner may have done effects but no terminal write survived.
  f.sql('UPDATE erp_cron_runs SET local_started_at=? WHERE run_key=?', ['2026-10-22T00:00:00Z', key]);
  assert.equal((await f.http(localBody)).status, 409); assert.equal(f.effects, 0);
  assert.equal((await finishTimerRun(f.DB, key, { ok: true, note: 'wrong success' }, () => {})).state, 'local_pending');
  assert.equal((await finishTimerRun(f.DB, key, { ok: true }, () => {}, 'wrong-owner')).state, 'local_pending');
  const api = await runApiStep(f.DB, localName, key, async () => assert.fail('API must not take local claim'), () => {}, 'external_clock');
  assert.equal(api.pending, true);
  const row = f.sql('SELECT finished_at,local_owner,api_owner FROM erp_cron_runs').results[0];
  assert.equal(row.finished_at, null); assert.equal(row.local_owner, claim.owner); assert.equal(row.api_owner, null);
  assert.equal((await finishTimerRun(f.DB, key, { ok: true, note: 'real owner done' }, () => {}, claim.owner)).state, 'finished');
});

test('lost local claim acknowledgement executes once; failed terminal writes never replay effects', async t => {
  const f = fixture(t, { name: localName, at: localAt, failure: { match: /SET local_owner/, times: 3 } });
  assert.equal((await f.http(localBody)).status, 200); assert.equal(f.effects, 1);
});

test('local terminal journal failure leaves durable ownership and returns pending on duplicate', async t => {
  const f = fixture(t, { name: localName, at: localAt, failure: { match: /SET finished_at/, times: 3, before: true } });
  assert.equal((await f.http(localBody)).status, 503); assert.equal(f.effects, 1);
  const row = f.sql('SELECT local_owner,finished_at FROM erp_cron_runs').results[0];
  assert.ok(row.local_owner); assert.equal(row.finished_at, null);
  assert.equal((await f.http(localBody)).status, 409); assert.equal(f.effects, 1);
});

test('old random-key invocation within execution budget blocks new local slot without hiding it', async t => {
  const f = fixture(t, { name: localName, at: localAt });
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at) VALUES(?,?,?,?)', [crypto.randomUUID(), localName, localCron, new Date(localAt - 60_000).toISOString()]);
  const result = await f.http(localBody);
  assert.equal(result.status, 409); assert.equal((await result.json()).localPending, true); assert.equal(f.effects, 0);
  assert.equal(f.sql('SELECT count(*) n FROM erp_cron_runs').results[0].n, 1);
  // A verified earlier completion permits this current slot; no old row is rewritten by the dispatcher.
  f.sql('UPDATE erp_cron_runs SET finished_at=?,ok=1', [new Date(localAt).toISOString()]);
  assert.equal((await f.http(localBody)).status, 200); assert.equal(f.effects, 1);
});


test('API ownership prevents local takeover without falsifying provenance', async t => {
  const f = fixture(t, { name: localName, at: localAt }), key = await slotRunKey(localName, localCron, localAt);
  f.sql('INSERT INTO erp_cron_runs(run_key,worker,cron,started_at,api_owner,api_started_at) VALUES(?,?,?,?,?,?)',
    [key, localName, localCron, 'start', 'existing-api-owner', 'accepted']);
  assert.equal((await claimLocalRun(f.DB, localName, key, 'external_clock', () => {})).state, 'pending');
  assert.deepEqual(f.sql('SELECT local_owner,api_owner,finished_at FROM erp_cron_runs').results,
    [{ local_owner: null, api_owner: 'existing-api-owner', finished_at: null }]);
  assert.equal(f.effects, 0);
});

test('local business failure remains failed, suppresses platform replay, and is not repeated by HTTP', async t => {
  const f = fixture(t, { name: localName, at: localAt });
  f.work = async () => { throw Error('fixture business failure after partial work'); };
  await assert.rejects(f.cf(localAt, localCron), /fixture business failure/);
  assert.equal(f.noRetries, 1); assert.equal(f.effects, 1);
  const duplicate = await f.http(localBody);
  assert.equal(duplicate.status, 503); assert.equal(f.effects, 1);
  const report = await duplicate.json();
  assert.equal(report.ok, false); assert.equal(report.localOwned, true);
  assert.equal(f.sql('SELECT ok FROM erp_cron_runs').results[0].ok, 0);
});
