import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPilotStore,sha256} from './store.mjs';
import {createOperationalCapture} from './capture.mjs';
import {createExportDestinationLedger} from './export-destination-ledger.mjs';
const enc=x=>new TextEncoder().encode(x);
const config={namespace:'pilot-ledger-test',agents:{angela:'shadow','diana-helios':'shadow'}};
function fixture() {
 const sql=new DatabaseSync(':memory:');
 for(const file of ['schema.sql','export-destination-ledger.schema.sql']) sql.exec(readFileSync(new URL(file,import.meta.url),'utf8'));
 const objects=new Map(), faults={};let writes=0,reads=0;
 const db={prepare(query) {const stmt=sql.prepare(query);return {bind(...args) {return {
  first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),run:async()=>{
   if(query.includes('INSERT INTO pilot_export_destination_receipts')&&faults.before) throw Error('before insert');
   const result=stmt.run(...args);writes++;
   if(query.includes('INSERT INTO pilot_export_destination_receipts')&&faults.after) throw Error('lost response');
   return {success:true,meta:{changes:Number(result.changes)}};
  }};}};}};
 const bucket={get:async key=>{reads++;if(faults.r2) throw Error('R2 down'); const b=objects.get(key);return b?{size:b.length,arrayBuffer:async()=>b.slice().buffer}:null;},put:async(key,b)=>objects.set(key,b.slice())};
 const store=createPilotStore({config,db,bucket,authorize:async()=>true});
 const capture=createOperationalCapture({config,store,sourceVerifier:async()=>true});
 const state={current:null};
 const make=overrides=>createExportDestinationLedger({config,db,store,authorize:async()=>true,readCurrentSource:async()=>state.current,...overrides});
 async function snapshot(row=task(),table='org_task_runs',revision='checkpoint-1',raw) {
  const body=raw??JSON.stringify(row);const expectedSha256=await sha256(enc(body));
  const result=await capture.captureD1Row({agent:row.agent_slug,table,checkpoint:revision,expectedSha256},body);
  state.current=enc(body);
  return {agent:row.agent_slug,table,sourceRowId:row.id,sourceRevision:revision,manifestId:result.manifest.manifest_id,expectedSha256};
 }
 return {sql,objects,faults,db,store,state,make,ledger:make(),snapshot,counters:()=>({writes,reads})};
}
const task=(extra={})=>({id:7,agent_slug:'diana-helios',task_id:'brief',due_date:'2026-11-05',status:'missed',exported_at:null,content:'Hello',...extra});
const chat=(extra={})=>({id:9,agent_slug:'angela',role:'assistant',channel:'telegram',content:'Offer',meta:'{"choices":["approve"],"callback_receipt":"opaque"}',created_at:'2026-11-05',...extra});
const scope=m=>({agent:m.agent,table:m.table,sourceRowId:m.sourceRowId});
test('off default, invalid modes, absent authorization and caller approval flags fail closed',async()=>{
 const f=fixture(),m=await f.snapshot();const before=f.counters();
 for(const configOverride of [undefined,{namespace:'pilot-ledger-test',agents:{}},{namespace:'production',agents:config.agents},{...config,agents:{angela:'primary'}}]) await assert.rejects(f.make({config:configOverride}).recordReceipt(m));
 for(const authorize of [undefined,async()=>false,async()=>({verified:true}),async()=>{throw Error('auth failed');}]) await assert.rejects(f.make({authorize}).recordReceipt(m));
 await assert.rejects(f.ledger.recordReceipt({...m,approved:true,verified:true}),/invalid_request/);
 assert.deepEqual(f.counters(),before);
});
test('independent actual snapshot read required; scoped identity and digest cannot be spoofed',async()=>{
 const f=fixture(),m=await f.snapshot();
 for(const patch of [{agent:'angela'},{table:'agent_chat_messages'},{sourceRowId:8},{sourceRevision:'old'},{expectedSha256:'0'.repeat(64)},{manifestId:'0'.repeat(64)},{table:'ugc_creators'},{agent:'diana'}]) await assert.rejects(f.ledger.recordReceipt({...m,...patch}));
 f.objects.clear();await assert.rejects(f.ledger.recordReceipt(m),/object_missing/);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,0);
});
test('immutable replay and concurrent inserts converge, old revision remains separately addressable',async()=>{
 const f=fixture(),m=await f.snapshot();
 const results=await Promise.all(Array.from({length:8},()=>f.ledger.recordReceipt(m)));
 assert.equal(new Set(results.map(r=>r.receipt.receipt_id)).size,1);
 assert.equal((await f.ledger.recordReceipt(m)).replay,true);
 const next=await f.snapshot(task({status:'done'}),'org_task_runs','checkpoint-2');await f.ledger.recordReceipt(next);
 const projection=await f.ledger.projectCurrent(scope(m));
 assert.equal(projection.archiveState,'current-content-archived');assert.equal(projection.receipts.filter(r=>r.state==='matches-current-content').length,1);
 assert.equal((await f.ledger.recordReceipt(m)).replay,true);
 assert.throws(()=>f.sql.exec('DELETE FROM pilot_export_destination_receipts'),/append_only/);
 assert.throws(()=>f.sql.exec("UPDATE pilot_export_destination_receipts SET source_revision='fake'"),/append_only/);
});
test('interrupted before write and lost D1 response reconcile by exact replay without duplicates',async()=>{
 const f=fixture(),m=await f.snapshot();f.faults.before=true;
 await assert.rejects(f.ledger.recordReceipt(m),/before insert/);f.faults.before=false;
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,0);
 f.faults.after=true;await assert.rejects(f.ledger.recordReceipt(m),/lost response/);f.faults.after=false;
 assert.equal((await f.ledger.recordReceipt(m)).replay,true);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,1);
});
test('conflicting stored receipt, corrupted archive and partial R2 failure are never accepted',async()=>{
 const f=fixture(),m=await f.snapshot();const {receipt}=await f.ledger.recordReceipt(m);
 f.faults.r2=true;await assert.rejects(f.ledger.recordReceipt(m),/R2 down/);await assert.rejects(f.ledger.projectCurrent(scope(m)),/R2 down/);f.faults.r2=false;
 f.sql.exec('DROP TRIGGER pilot_export_receipts_no_update');
 f.sql.prepare('UPDATE pilot_export_destination_receipts SET source_sha256=?').run('0'.repeat(64));
 await assert.rejects(f.ledger.recordReceipt(m),/receipt_conflict/);await assert.rejects(f.ledger.projectCurrent(scope(m)),/archive_identity_mismatch/);
 f.objects.set(receipt.archive_object_key,enc('corrupt'));await assert.rejects(f.ledger.recordReceipt(m),/object_integrity_failure/);
});
test('task marker bookkeeping changes do not hide operational status, content, or unknown-field drift',async()=>{
 const f=fixture(),m=await f.snapshot();await f.ledger.recordReceipt(m);
 f.state.current=enc(JSON.stringify(task({exported_at:'2026-11-05T07:00Z'})));
 let p=await f.ledger.projectCurrent(scope(m));assert.equal(p.archiveState,'current-content-archived');assert.equal(p.legacyGitExport.state,'legacy-marker-present');assert.equal(p.legacyGitExport.deliveryVerified,false);
 assert.equal(p.cutoverReady,false);assert.equal(p.legacyDashboardCountsUnchanged,true);
 for(const extra of [{status:'done'},{content:'changed'},{unknown_future_column:'new'},{distilled_at:'wrong-table-marker'}]) {
  f.state.current=enc(JSON.stringify(task(extra)));assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
 }
 f.state.current=null;assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
});
test('chat omitted marker and subsequent marker update retain content match, unknown new column does not',async()=>{
 const f=fixture(),m=await f.snapshot(chat(),'agent_chat_messages');await f.ledger.recordReceipt(m);
 let p=await f.ledger.projectCurrent(scope(m));assert.deepEqual(p.legacyGitExport.observation,{present:false});
 f.state.current=enc(JSON.stringify(chat({distilled_at:'2026-11-05'})));
 p=await f.ledger.projectCurrent(scope(m));assert.equal(p.archiveState,'current-content-archived');assert.deepEqual(p.receipts[0].archivedLegacyMarker,{present:false});assert.deepEqual(p.receipts[0].archivedStatus,{present:false});
 f.state.current=enc(JSON.stringify(chat({future_db_column:null})));assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
});
test('canonical contract preserves raw bytes, unknown policy/meta data and numeric tokens conservatively',async()=>{
 const f=fixture();const row=task({content:'Pre-agreement scouting outside ERP cards',meta:{human_set_stage:'manual',manual_review:true,telegram_message_id:'009',choices:['accept','decline'],callback_receipt:{choice:'accept',acted:false}},unknown:{b:2,a:1}});
 const raw=JSON.stringify(row,null,2)+'\n';const m=await f.snapshot(row,'org_task_runs','checkpoint-1',raw);const {receipt}=await f.ledger.recordReceipt(m);
 assert.equal(new TextDecoder().decode((await f.store.readSnapshot(m.agent,m.manifestId)).bytes),raw);
 f.state.current=enc(JSON.stringify(Object.fromEntries(Object.entries(row).reverse())));assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'current-content-archived');
 f.state.current=enc(JSON.stringify({...row,meta:{...row.meta,manual_review:false}}));assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
 f.state.current=enc(raw.replace('"b": 2','"b": 2.0'));assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
 assert.equal(receipt.source_status_json,'{"present":true,"value":"missed"}');
});
test('duplicate keys, malformed bytes and unsupported current identities fail instead of losing fields',async()=>{
 const f=fixture(),m=await f.snapshot();await f.ledger.recordReceipt(m);
 for(const raw of [JSON.stringify(task()).replace('"content":"Hello"','"content":"Hello","content":"evil"'),JSON.stringify(task({id:8})),JSON.stringify(task()).slice(0,-1)+',"nested":{"x":1,"x":2}}']) {
  f.state.current=enc(raw);await assert.rejects(f.ledger.projectCurrent(scope(m)));
 }
 await assert.rejects(f.make({readCurrentSource:undefined}).projectCurrent(scope(m)),/current_source_reader_required/);
});
test('same row IDs in another scope and old IDs cannot reuse receipts',async()=>{
 const f=fixture(),m=await f.snapshot();await f.ledger.recordReceipt(m);
 const other=await f.snapshot(task({agent_slug:'angela'}));await f.ledger.recordReceipt(other);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,2);
 const differentNamespace=f.make({config:{...config,namespace:'pilot-other'}});
 await assert.rejects(differentNamespace.recordReceipt(m),/archive_identity_mismatch/);
 f.state.current=enc(JSON.stringify(task({id:7,task_id:'reused-id',status:'done'})));
 assert.equal((await f.ledger.projectCurrent(scope(m))).archiveState,'historical-only');
});
test('OR REPLACE cannot alter immutable receipt with recursive triggers disabled',async()=>{
 const f=fixture(),m=await f.snapshot();const {receipt}=await f.ledger.recordReceipt(m);
 f.sql.exec('PRAGMA recursive_triggers = OFF');
 const keys=Object.keys(receipt), values=Object.values({...receipt,source_sha256:'0'.repeat(64)});
 f.sql.prepare(`INSERT OR REPLACE INTO pilot_export_destination_receipts (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...values);
 assert.equal((await f.ledger.recordReceipt(m)).replay,true);
});
test('projection bounds fail closed, byte input is validated before copying',async()=>{
 const f=fixture();let m;
 for(let i=0;i<33;i++){m=await f.snapshot(task(),'org_task_runs',`revision-${i}`);await f.ledger.recordReceipt(m);}
 await assert.rejects(f.ledger.projectCurrent(scope(m)),/projection_receipt_limit/);
 f.state.current={approved:true};await assert.rejects(f.ledger.projectCurrent(scope(m)),/invalid_current_source_bytes/);
 f.state.current=new Uint8Array(32*1024*1024+1);await assert.rejects(f.ledger.projectCurrent(scope(m)),/invalid_current_source_bytes/);
 const g=fixture(),n=await g.snapshot();await g.ledger.recordReceipt(n);
 const n2=await g.snapshot(task(),'org_task_runs','two');await g.ledger.recordReceipt(n2);
 g.sql.exec('DROP TRIGGER pilot_export_receipts_no_update');g.sql.exec('UPDATE pilot_export_destination_receipts SET source_content_bytes = 33554432');
 await assert.rejects(g.ledger.projectCurrent(scope(n)),/projection_archive_byte_limit/);
});
test('failed D1 read response never looks like an empty receipt ledger',async()=>{
 const f=fixture(),m=await f.snapshot();
 const db={prepare:()=>({bind:()=>({all:async()=>({success:false,results:[]})})})};
 await assert.rejects(f.make({db}).projectCurrent(scope(m)),/receipt_query_failed/);
});
