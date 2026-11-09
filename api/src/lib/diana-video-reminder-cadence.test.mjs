import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const output = await build({entryPoints:[fileURLToPath(new URL('./ugc-payout-store.ts', import.meta.url))],
  bundle:true, platform:'node', format:'esm', write:false});
const {overdueVideoReminders} = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ugc_payouts(id TEXT,creator_id TEXT,handle TEXT,paid_at TEXT,status TEXT);
    CREATE TABLE ugc_creators(id TEXT,lifecycle_stage TEXT);
    CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,created_at TEXT,direction TEXT,from_username TEXT);
    CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    INSERT INTO ugc_creators VALUES('creator','creation');
    INSERT INTO ugc_payouts VALUES('p1','creator','alice','2026-11-01T00:00:00.000Z','paid');
    INSERT INTO ugc_ig_messages VALUES('m1','chat','2026-11-01T01:00:00.000Z','in','alice');`);
  const env = {DB:{prepare(sql){let args=[]; const s={bind(...a){args=a;return s},
    async first(){return db.prepare(sql).get(...args)??null},
    async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}}}};return s}}};
  return {db,env};
}

test('queues after five full days, keeps one open event, then queues the next five-day cycle', async t => {
  const {db,env}=fixture(); t.after(()=>db.close());
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-05T23:59:59Z')),0);
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-06T00:00:00Z')),1);
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-11T00:00:00Z')),0); // first still pending
  const first = JSON.parse(db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").get().value);
  assert.equal(first.reminder_cycle,1);
  db.prepare('DELETE FROM crm_sync_state WHERE key=?').run('diana_action_pending:'+first.event_id);
  db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_event_done:'+first.event_id,'{"verified":true}',1);
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-11T00:00:00Z')),1);
  const second = JSON.parse(db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").get().value);
  assert.equal(second.reminder_cycle,2);
  assert.notEqual(second.event_id,first.event_id);
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-11T00:01:00Z')),0);
});

test('a legacy outstanding event blocks a second task and posted creators do not enter the queue', async t => {
  const {db,env}=fixture(); t.after(()=>db.close());
  db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_action_pending:old', JSON.stringify({task:'video_reminder',payout_id:'p1'}),1);
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-11T00:00:00Z')),0);
  db.prepare('DELETE FROM crm_sync_state').run();
  db.prepare("UPDATE ugc_creators SET lifecycle_stage='posted'").run();
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-11T00:00:00Z')),0);
});

test('a late first pass queues only the current cycle, not a stack of missed reminders', async t => {
  const {db,env}=fixture(); t.after(()=>db.close());
  assert.equal(await overdueVideoReminders(env, Date.parse('2026-11-16T00:00:00Z')),1);
  const pending=db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").all();
  assert.equal(pending.length,1);
  assert.equal(JSON.parse(pending[0].value).reminder_cycle,3);
});
