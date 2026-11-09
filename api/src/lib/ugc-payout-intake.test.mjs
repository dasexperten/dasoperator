import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
const dir=mkdtempSync(join(tmpdir(),'payout-intake-'));
await build({entryPoints:[fileURLToPath(new URL('./ugc-payout-intake.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'intake.mjs')});
const {prepareCreatorPayout}=await import(pathToFileURL(join(dir,'intake.mjs')));rmSync(dir,{recursive:true});
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE ugc_creators(id TEXT PRIMARY KEY,normalized_handle TEXT,lifecycle_stage TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE ugc_creator_platforms(id TEXT PRIMARY KEY,creator_id TEXT,platform TEXT,handle TEXT,normalized_handle TEXT,profile_url TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,UNIQUE(platform,normalized_handle));
 CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,creator_id TEXT,creator_platform_id TEXT,platform TEXT,handle TEXT,amount_minor INTEGER,currency TEXT,status TEXT,payout_date TEXT,marketplace TEXT,phone_masked TEXT,bank_ref TEXT,fps_bank_member_id TEXT,product TEXT,note TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,konsol_payment_id TEXT,execute_claim TEXT,paid_at TEXT,sent_at TEXT,approved_at TEXT,approved_by TEXT);
 CREATE TABLE ugc_payout_requisites(payout_id TEXT PRIMARY KEY,fps_mobile_phone TEXT,first_name TEXT,last_name TEXT,patronymic TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT,from_username TEXT,created_at TEXT);
 INSERT INTO ugc_ig_messages VALUES('amount','chat','in','alice','2026-11-08T10:00:00Z'),('bank','chat','in','alice','2026-11-08T11:00:00Z'),('new-bank','chat','in','alice','2026-11-09T11:00:00Z');`);
 const DB={prepare(sql){let params=[];return {statement:{sql,get params(){return params}},bind(...p){params=p;return this},async first(){return db.prepare(sql).get(...params)??null}}},async batch(qs){db.exec('BEGIN');try{const results=qs.map(q=>({meta:{changes:db.prepare(q.statement.sql).run(...q.statement.params).changes}}));db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}};
 return {db,env:{DB}};
}
const facts={verified:true,handle:'alice',conversation_id:'chat',cycle_message_id:'amount',source_message_ids:['amount','bank'],amount_minor:45300,phone:'+79990000000',first_name:'Alice',fps_bank_member_id:'100000000004',bank_ref:'T-Bank'};
const now=Date.parse('2026-11-09T12:00:00Z');
test('ready original facts create one approval row with protected details; replay is safe',async()=>{
 const f=fixture();try{
  const a=await prepareCreatorPayout(f.env,facts,now),b=await prepareCreatorPayout(f.env,facts,now);
  assert.equal(a.id,b.id);assert.equal(a.status,'awaiting_approval');assert.equal(a.amount_minor,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,1);
  assert.equal(f.db.prepare('SELECT first_name,last_name FROM ugc_payout_requisites').get().last_name,null);
  assert.equal(f.db.prepare('SELECT lifecycle_stage FROM ugc_creators').get().lifecycle_stage,'cart');
  assert.equal(JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state').get().value).verified,true);
 }finally{f.db.close()}
});
test('new bank facts update the same unpaid row and stale details cannot overwrite them',async()=>{
 const f=fixture();try{
  const a=await prepareCreatorPayout(f.env,facts,now);
  const b=await prepareCreatorPayout(f.env,{...facts,source_message_ids:['amount','new-bank'],bank_ref:'Ozon',fps_bank_member_id:'100000000273'},now);
  assert.equal(a.id,b.id);assert.equal(b.bank_ref,'Ozon');
  await assert.rejects(prepareCreatorPayout(f.env,facts,now),/newer_payment_details/);
 }finally{f.db.close()}
});
test('missing original, wrong creator and unverified facts do not create a payout',async()=>{
 for(const patch of [{verified:false},{handle:'someone_else'},{conversation_id:'other'},{phone:'123'}]){
  const f=fixture();try{await assert.rejects(prepareCreatorPayout(f.env,{...facts,...patch},now));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0)}finally{f.db.close()}
 }
});
test('a handed-over or paid current cycle cannot be recreated or have its bank changed',async()=>{
 const f=fixture();try{
  const a=await prepareCreatorPayout(f.env,facts,now);
  f.db.prepare("UPDATE ugc_payouts SET status='paid',konsol_payment_id='payment',paid_at='2026-11-09T11:30:00Z' WHERE id=?").run(a.id);
  await assert.rejects(prepareCreatorPayout(f.env,facts,now),/already_handed_over/);
  assert.equal(f.db.prepare('SELECT status FROM ugc_payouts').get().status,'paid');
 }finally{f.db.close()}
});
test('a failed protected-details write rolls back approval row and receipt together',async()=>{
 const f=fixture();try{
  f.db.exec("CREATE TRIGGER fail_details BEFORE INSERT ON ugc_payout_requisites BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;");
  await assert.rejects(prepareCreatorPayout(f.env,facts,now),/storage unavailable/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM crm_sync_state').get().n,0);
 }finally{f.db.close()}
});

test('intake preserves an Owner-entered amount while accepting newer bank details',async()=>{
 const f=fixture();try{const a=await prepareCreatorPayout(f.env,facts,now);f.db.prepare('UPDATE ugc_payouts SET amount_minor=48700 WHERE id=?').run(a.id);
 const b=await prepareCreatorPayout(f.env,{...facts,source_message_ids:['amount','new-bank']},now);assert.equal(b.amount_minor,48700);
 }finally{f.db.close()}
});
test('a claimed execution cannot have its bank changed by intake',async()=>{
 const f=fixture();try{const a=await prepareCreatorPayout(f.env,facts,now);f.db.prepare("UPDATE ugc_payouts SET execute_claim='running' WHERE id=?").run(a.id);
 await assert.rejects(prepareCreatorPayout(f.env,facts,now),/already_handed_over/);
 }finally{f.db.close()}
});
