import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'erp-run-journal-'));
const outfile = join(dir, 'run.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./run.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { runLogged, erpWorker } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

function fixture(t, options = {}) {
  const f = { rows: new Map(), claims: new Map(), attempts: { insert: 0, finish: 0 }, jobs: 0, logs: [] };
  t.mock.method(console, 'log', (...args) => f.logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => f.logs.push(args.join(' ')));
  const fail = (phase, when) => {
    const spec = options[phase];
    if (spec && spec.when === when && f.attempts[phase] <= (spec.times ?? Infinity)) throw Error(spec.error ?? 'D1_ERROR: Network connection lost');
  };
  f.env = { DB: { prepare(sql) {
    let args;
    const q = { bind(...values) { args = values; return q; },
      async first() {
        if (sql.startsWith('SELECT')) { if (options.healthError) throw Error('Network connection lost'); return options.lastRun ?? null; }
        if (sql.includes('erp_cron_runs')) { // Legacy path makes the pre-fix regressions observable.
          f.attempts.insert++; fail('insert', 'before');
          const row = { id: 1, finished_at: null }; f.rows.set(1, row); fail('insert', 'after'); return row;
        }
        if (sql.includes('erp_job_claims')) {
          if (f.claims.has(args[0])) return null;
          if (options.slotError && args[0].startsWith('slot:')) throw Error('slot unavailable');
          f.claims.set(args[0], args[1]); return { worker: args[0] };
        }
        throw Error('Unexpected first: ' + sql);
      },
      async run() {
        if (sql.startsWith('DELETE')) { if (options.cleanupError && args[0].startsWith('lock:')) throw Error('lock cleanup unavailable'); const owned = f.claims.get(args[0]) === args[1]; if (owned) f.claims.delete(args[0]); return { success: true, meta: { changes: owned ? 1 : 0 } }; }
        if (sql.startsWith('INSERT INTO erp_cron_runs')) {
          f.attempts.insert++; fail('insert', 'before');
          const exists = f.rows.has(args[0]); if (!exists) f.rows.set(args[0], { run_key: args[0], finished_at: null });
          fail('insert', 'after'); return { success: true, meta: { changes: exists ? 0 : 1 } };
        }
        if (sql.startsWith('UPDATE erp_cron_runs')) {
          f.attempts.finish++; fail('finish', 'before');
          const row = f.rows.get(args[5]);
          if (row && !options.missingTerminal) Object.assign(row, { finished_at: args[0], ok: args[1], note: args[3], error: args[4] });
          fail('finish', 'after'); return { success: true, meta: { changes: row && !options.missingTerminal ? 1 : 0 } };
        }
        throw Error('Unexpected run: ' + sql);
      }
    }; return q;
  } } };
  f.job = async (_env, _dry, _cron, context) => { f.jobs++; f.context = context; if (options.jobError) throw Error(options.jobError); return { rows: 2, note: 'private business payload' }; };
  return f;
}

test('lost insert acknowledgement retries the same UUID and executes the job once', async t => {
  const f = fixture(t, { insert: { when: 'after', times: 1 } });
  const report = await runLogged(f.env, 'erp-test', '* * * * *', f.job, 123);
  assert.equal(report.ok, true); assert.equal(f.jobs, 1); assert.equal(f.rows.size, 1);
  assert.equal(f.attempts.insert, 2); assert.ok([...f.rows.values()][0].finished_at);
  assert.equal(f.context.runKey, [...f.rows.keys()][0]); assert.equal(f.context.scheduledTime, 123);
  assert.ok(f.logs.some(line => line.includes(f.context.runKey)));
  assert.ok(f.logs.every(line => !line.includes('private business payload')));
});
for (const error of ['Network connection lost', 'storage caused object to be reset', 'reset because its code was updated']) {
  test('bounded transient insert failure prevents any work: ' + error, async t => {
    const f = fixture(t, { insert: { when: 'before', error } });
    const report = await runLogged(f.env, 'erp-test', 'manual', f.job);
    assert.equal(report.ok, false); assert.equal(report.journalError, 'insert'); assert.equal(f.jobs, 0);
    assert.equal(f.attempts.insert, 3);
  });
}
test('permanent insert failure is not retried', async t => {
  const f = fixture(t, { insert: { when: 'before', error: 'no such column: run_key' } });
  const report = await runLogged(f.env, 'erp-test', 'manual', f.job);
  assert.equal(report.ok, false); assert.equal(f.jobs, 0); assert.equal(f.attempts.insert, 1);
});
for (const when of ['before', 'after']) {
  test('transient terminal failure ' + when + ' commit retries only the journal', async t => {
    const f = fixture(t, { finish: { when, times: 1 } });
    const report = await runLogged(f.env, 'erp-test', 'manual', f.job);
    assert.equal(report.ok, true); assert.equal(f.jobs, 1); assert.equal(f.attempts.finish, 2);
    assert.equal([...f.rows.values()][0].ok, 1);
  });
}
test('zero-row terminal update is a visible failure with the job outcome retained', async t => {
  const f = fixture(t, { missingTerminal: true });
  const report = await runLogged(f.env, 'erp-test', 'manual', f.job);
  assert.equal(report.ok, false); assert.equal(report.jobOk, true); assert.equal(report.journalError, 'finish');
  assert.equal(f.attempts.finish, 1); assert.equal(f.jobs, 1);
});
async function scheduled(f) {
  let pending, suppressed = 0;
  await erpWorker('erp-test', f.job).scheduled({ cron: '* * * * *', scheduledTime: 123, noRetry() { suppressed++; } }, f.env, { waitUntil(p) { pending = p; } });
  await assert.rejects(pending);
  return suppressed;
}
test('exhausted terminal writes fail the event but suppress platform re-execution', async t => {
  const f = fixture(t, { finish: { when: 'before' } });
  assert.equal(await scheduled(f), 1); assert.equal(f.jobs, 1); assert.equal(f.attempts.finish, 3);
});
test('ordinary job failures are recorded and retain platform retry policy', async t => {
  const f = fixture(t, { jobError: 'upstream unavailable' });
  assert.equal(await scheduled(f), 0); assert.equal(f.jobs, 1);
  assert.equal([...f.rows.values()][0].ok, 0); assert.equal([...f.rows.values()][0].error, 'upstream unavailable');
});
test('pre-job journal failures retain platform retry policy', async t => {
  const f = fixture(t, { insert: { when: 'before' } });
  assert.equal(await scheduled(f), 0); assert.equal(f.jobs, 0);
});
test('WB journal failure releases its lock and unconsumed scheduled slot', async t => {
  const f = fixture(t, { insert: { when: 'before', error: 'constraint failed' } });
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, false); assert.equal(f.jobs, 0); assert.equal(f.claims.size, 0);
});
test('WB terminal failure releases the lock but preserves the consumed slot', async t => {
  const f = fixture(t, { finish: { when: 'before', error: 'constraint failed' } });
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, false); assert.equal(f.jobs, 1);
  assert.deepEqual([...f.claims.keys()], ['slot:erp-wb-test:123']);
});
test('WB duplicate slot is skipped and its invocation lock released', async t => {
  const f = fixture(t); f.claims.set('slot:erp-wb-test:123', '123');
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, true); assert.match(report.note, /already handled/);
  assert.equal(f.jobs, 0); assert.equal(f.claims.size, 1);
});
test('WB slot registration failure still releases the lock', async t => {
  const f = fixture(t, { slotError: true });
  await assert.rejects(runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123), /slot unavailable/);
  assert.equal(f.jobs, 0); assert.equal(f.claims.size, 0);
});
test('health exposes unavailable journal instead of green', async t => {
  const f = fixture(t, { healthError: true });
  const response = await erpWorker('erp-test', f.job).fetch(new Request('https://test/health'), f.env);
  assert.equal(response.status, 503); const body = await response.json();
  assert.equal(body.ok, false); assert.equal(body.last_run_status, 'unavailable');
});
for (const [lastRun, status] of [[null, 'none'], [{ finished_at: null, ok: null }, 'running'], [{ finished_at: null, ok: 0, transport_error: 'timeout' }, 'completion_unconfirmed'], [{ finished_at: 'now', ok: 1 }, 'succeeded'], [{ finished_at: 'now', ok: 0 }, 'failed']]) {
  test('health distinguishes journal state ' + status, async t => {
    const f = fixture(t, { lastRun });
    const response = await erpWorker('erp-test', f.job).fetch(new Request('https://test/health'), f.env);
    assert.equal(response.status, 200); assert.equal((await response.json()).last_run_status, status);
  });
}

test('lock cleanup failure cannot mask the final journal failure or its job outcome', async t => {
  const f = fixture(t, { finish: { when: 'before', error: 'constraint failed' }, cleanupError: true });
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, false); assert.equal(report.journalError, 'finish'); assert.equal(report.jobOk, true);
  assert.equal(f.jobs, 1); assert.ok(f.logs.some(line => line.includes('lock_release_failed')));
});
test('missing noRetry capability is explicitly logged without replaying the completed job', async t => {
  const f = fixture(t, { finish: { when: 'before', error: 'constraint failed' } });
  let pending;
  await erpWorker('erp-test', f.job).scheduled({ cron: 'timer', scheduledTime: 123 }, f.env, { waitUntil(p) { pending = p; } });
  await pending;
  assert.equal(f.jobs, 1);
  assert.ok(f.logs.some(line => line.includes('journal_finish_failed_no_retry_unavailable') && line.includes('"ok":false')));
});
test('WB held lock skips without claiming a slot or releasing another lease', async t => {
  const f = fixture(t); f.claims.set('lock:erp-wb-test', 'another-owner');
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, true); assert.match(report.note, /already running/);
  assert.equal(f.jobs, 0); assert.equal(f.claims.get('lock:erp-wb-test'), 'another-owner');
});
test('WB dry run preserves its existing bypass of live lock and slot guards', async t => {
  const f = fixture(t); f.env.DRY_RUN = '1';
  const report = await runLogged(f.env, 'erp-wb-test', 'timer', f.job, 123);
  assert.equal(report.ok, true); assert.equal(report.dry, true); assert.equal(f.jobs, 1); assert.equal(f.claims.size, 0);
});
