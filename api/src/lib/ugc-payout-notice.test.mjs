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
const dir = mkdtempSync(join(tmpdir(), 'payout-notice-'));
const outfile = join(dir, 'handoff.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ugc-payout-notice.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { recordPayoutNotice } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,handle TEXT,status TEXT,paid_at TEXT,konsol_payment_id TEXT,notice_status TEXT,notice_message_id TEXT,notice_at TEXT,notice_error TEXT,paid_notice_at TEXT,updated_at INTEGER);
    CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT,from_username TEXT,created_at TEXT);
    CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    INSERT INTO ugc_payouts VALUES('p1','creator','paid','2026-11-01T12:00:00Z','k1',NULL,NULL,NULL,NULL,'2026-11-01T12:00:02Z',1);
    INSERT INTO ugc_ig_messages VALUES('in1','chat1','in','creator','2026-11-01T11:00:00Z');
    INSERT INTO ugc_ig_messages VALUES('out1','chat1','out','dasexperten','2026-11-01T12:00:05Z');`);
  const DB = {prepare(sql){let args=[];return {bind(...v){args=v;return this},sql,get args(){return args},async first(){return db.prepare(sql).get(...args)??null}}},async batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>({meta:{changes:Number(db.prepare(s.sql).run(...s.args).changes)}}));db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
  return {db,env:{DB}};
}
const proof={verified:true,message_id:'out1',conversation_id:'chat1',evidence:'Diana opened the original Meta message and verified the payment notice and amount.'};
test('verified original proof atomically restores all delivery fields and receipt; repeat is safe',async()=>{
  const {db,env}=fixture();
  await recordPayoutNotice(env,'p1',proof);
  await recordPayoutNotice(env,'p1',proof);
  const row=db.prepare('SELECT * FROM ugc_payouts').get();
  assert.equal(row.status,'paid');assert.equal(row.konsol_payment_id,'k1');
  assert.equal(row.notice_status,'delivered');assert.equal(row.notice_message_id,'out1');
  assert.equal(row.paid_notice_at,'2026-11-01T12:00:05.000Z');
  assert.equal(JSON.parse(db.prepare('SELECT value FROM crm_sync_state').get().value).verified,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_sync_state').get().n,1);db.close();
});
test('wrong conversation, old message, incoming message or unverified assertion cannot mark delivery',async()=>{
  for(const change of [{conversation_id:'other'},{message_id:'in1'},{verified:false},{evidence:''}]){
    const {db,env}=fixture();await assert.rejects(recordPayoutNotice(env,'p1',{...proof,...change}));
    assert.equal(db.prepare('SELECT notice_status FROM ugc_payouts').get().notice_status,null);db.close();
  }
  const {db,env}=fixture();db.prepare("UPDATE ugc_ig_messages SET created_at='2026-11-01T11:59:59Z' WHERE id='out1'").run();
  await assert.rejects(recordPayoutNotice(env,'p1',proof),/message_must_follow_payment/);db.close();
});
test('unpaid row and a conflicting prior delivery stay unchanged',async()=>{
  for(const sql of ["UPDATE ugc_payouts SET status='sent'", "UPDATE ugc_payouts SET notice_status='delivered',notice_message_id='different'"]){
    const {db,env}=fixture();db.exec(sql);await assert.rejects(recordPayoutNotice(env,'p1',proof));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_sync_state').get().n,0);db.close();
  }
});
