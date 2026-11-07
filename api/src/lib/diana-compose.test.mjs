import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'diana-handoff-'));
const outfile = join(dir, 'handoff.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./diana-compose.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { queueDianaAction } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,created_at TEXT,direction TEXT,from_username TEXT);
    CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    INSERT INTO ugc_ig_messages VALUES('msg1','chat1','2026-11-07T12:00:00Z','in','creator');`);
  const env = { DB: { prepare(sql) { let args=[]; return { bind(...v){args=v;return this}, async first(){return db.prepare(sql).get(...args)??null},async run(){return db.prepare(sql).run(...args)} }; } } };
  return {db,env};
}

test('payout handoff persists one metadata event and respects its verified receipt', async () => {
  const {db,env}=fixture();
  const first=await queueDianaAction(env,'@Creator','','payout:p1:paid');
  assert.equal(first.queued,true);
  assert.equal((await queueDianaAction(env,'creator','','payout:p1:paid')).eventId,first.eventId);
  let rows=db.prepare('SELECT * FROM crm_sync_state').all();
  assert.equal(rows.length,1);
  const alarm=JSON.parse(rows[0].value);
  assert.equal(alarm.reason,'diana_action_pending');
  assert.equal(alarm.cid,'chat1');
  assert.equal(alarm.message_id,'msg1');
  assert.equal(alarm.handle,'creator');
  assert.equal(Object.hasOwn(alarm,'text'),false);
  db.prepare('DELETE FROM crm_sync_state').run();
  db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_event_done:'+first.eventId,'{"verified":true}',1);
  assert.equal((await queueDianaAction(env,'creator','','payout:p1:paid')).completed,true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'diana_action_pending:%'").get().n,0);
  assert.equal((await queueDianaAction(env,'creator','','payout:p1:failed')).queued,true);
  db.close();
});

test('missing original conversation reports failure without inventing an alarm', async () => {
  const {db,env}=fixture();
  const result=await queueDianaAction(env,'missing','','payout:p2:paid');
  assert.equal(result.ok,false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_sync_state').get().n,0);
  db.close();
});
