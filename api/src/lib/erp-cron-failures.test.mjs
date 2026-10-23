import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Execute the production recovery statement in SQLite, including its correlated
// subquery. A hand-written D1 mock would miss SQL predicate regressions.
const source = readFileSync(new URL('./erp-cron-failures.ts', import.meta.url), 'utf8');
const recovery = source.match(/`(UPDATE erp_cron_runs SET notified[\s\S]*?)`/)[1];
function recovered(rows) {
  const script = `import sqlite3,json,sys
p=json.load(sys.stdin)
d=sqlite3.connect(':memory:')
d.execute('CREATE TABLE erp_cron_runs (id INTEGER PRIMARY KEY, worker TEXT, ok INTEGER, finished_at TEXT, notified INTEGER DEFAULT 0, note TEXT)')
d.executemany('INSERT INTO erp_cron_runs(id,worker,ok,finished_at,note) VALUES(?,?,?,?,?)',p['rows'])
d.execute(p['sql'])
print(json.dumps(d.execute('SELECT id FROM erp_cron_runs WHERE notified=1 ORDER BY id').fetchall()))`;
  return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify({ sql: recovery, rows }), encoding: 'utf8' })).flat();
}
const failed = [1, 'erp-ugc-direct', 0, '2026-10-23T12:01:00Z', null];
const success = [2, 'erp-ugc-direct', 1, '2026-10-23T12:02:00Z', 'ig_dm: work completed'];

test('a later completed success recovers a completed failure', () => {
  assert.deepEqual(recovered([failed, success]), [1]);
});
test('a still-running row is never marked recovered', () => {
  assert.deepEqual(recovered([[...failed.slice(0, 3), null, null], success]), []);
});
test('unfinished, idle, or locked later rows do not prove recovery', () => {
  for (const later of [
    [...success.slice(0, 3), null, 'work'],
    [...success.slice(0, 4), 'ig_dm: not due'],
    [...success.slice(0, 4), 'ig_dm: taken by another run'],
  ]) assert.deepEqual(recovered([failed, later]), []);
});
test('another worker or an earlier success cannot recover the failure', () => {
  assert.deepEqual(recovered([failed, [2, 'erp-other', 1, success[3], 'work'], [0, ...success.slice(1)]]), []);
});
