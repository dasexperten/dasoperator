import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPilotStore,sha256} from './store.mjs';
import {createOperationalCapture} from './capture.mjs';
import {createExportDestinationLedger} from './export-destination-ledger.mjs';
import {createNightlyArchiveReceiptAdapter} from './nightly-archive-receipt-adapter.mjs';
const enc=s=>new TextEncoder().encode(s);
const config={namespace:'pilot-adapter',agents:{angela:'shadow','diana-helios':'shadow'}};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const task=(id=1,extra={})=>({id,agent_slug:'diana-helios',task_id:'t',due_date:'2026-11-05',status:'missed',exported_at:null,title:'Joined title',...extra});
const chat=(id=1,extra={})=>({id,agent_slug:'angela',role:'assistant',channel:'telegram',content:'Hi',meta:'{"manual_review":true,"choices":["send"],"callback_receipt":"opaque"}',created_at:'now',...extra});
async function event(rows=[task()],sourceTable='org_task_runs') {
 const rowsJson=JSON.stringify(canonical(rows)), agent=rows[0].agent_slug, namespace=config.namespace;
 return {namespace,sourceTable,agent,observedAt:'2026-11-05T10:00:00.000Z',rows:JSON.parse(rowsJson),rowsJson,
 snapshotSha256:await sha256(enc(JSON.stringify({namespace,sourceTable,agent,rowsJson}))),selection:sourceTable==='org_task_runs'?'pending_runs_join_task_title':'oldest_500_undistilled_chat_projection'};
}
function fixture() {
 const sql=new DatabaseSync(':memory:');for(const path of ['schema.sql','export-destination-ledger.schema.sql'])sql.exec(readFileSync(new URL(path,import.meta.url),'utf8'));
 const faults={},objects=new Map(),checkpoints=new Map();let insertCount=0;
 const db={prepare(query){const stmt=sql.prepare(query);return {bind(...args){return {first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),run:async()=>{
  const receipt=query.includes('INSERT INTO pilot_export_destination_receipts');
  if(receipt&&faults.receiptBefore)throw Error('D1 before');
  const result=stmt.run(...args);insertCount++;
  if((receipt&&faults.receiptAfter)||(!receipt&&faults.manifestAfter))throw Error('response lost');
  return {success:true,meta:{changes:Number(result.changes)}};
 }};}};}};
 const bucket={get:async key=>{if(faults.r2)throw Error('R2 down');const b=objects.get(key);return b?{size:b.length,arrayBuffer:async()=>b.slice().buffer}:null;},put:async(key,b)=>objects.set(key,b.slice())};
 const store=createPilotStore({config,db,bucket,authorize:async()=>true});
 const capture=createOperationalCapture({config,store,sourceVerifier:async()=>true});
 const ledger=createExportDestinationLedger({config,db,store,authorize:async()=>true});
 const verifySnapshot=async locator=>structuredClone(checkpoints.get(locator.snapshotSha256));
 const make=overrides=>createNightlyArchiveReceiptAdapter({config,capture,ledger,authorize:async()=>true,verifySnapshot,...overrides});
 function register(e){checkpoints.set(e.snapshotSha256,{namespace:e.namespace,agent:e.agent,sourceTable:e.sourceTable,selection:e.selection,rowsJson:e.rowsJson});}
 return {sql,objects,faults,store,capture,ledger,make,adapter:make(),register,count:()=>insertCount};
}
test('off/auth/trusted independent checkpoint required and flags cannot authorize',async()=>{
 const f=fixture(),e=await event();f.register(e);
 for(const overrides of [{config:undefined},{authorize:undefined},{authorize:async()=>false},{authorize:async()=>({approved:true})},{verifySnapshot:undefined},{verifySnapshot:async()=>true},{verifySnapshot:async()=>({verified:true})}]) await assert.rejects(f.make(overrides).observe(e));
 await assert.rejects(f.adapter.observe({...e,approved:true}));assert.equal(f.count(),0);
});
test('full group scope/hash/deterministic bytes/duplicate ID validation precedes any writes',async()=>{
 const f=fixture(),e=await event();f.register(e);
 for(const change of [{namespace:'pilot-other'},{agent:'other'},{sourceTable:'ugc_creators'},{selection:'arbitrary'},{snapshotSha256:'0'.repeat(64)},{rowsJson:e.rowsJson+' '},{rows:[task(9)]},{observedAt:'bad'}]) await assert.rejects(f.adapter.observe({...e,...change}));
 for(const rows of [[task(),task()],[task(),task(2,{agent_slug:'angela'})],[task(),task(2,{status:'bad\nstatus'})]]) {
  const invalid=await event(rows);f.register(invalid);await assert.rejects(f.adapter.observe(invalid));
 }
 assert.equal(f.count(),0);
});
test('checkpoint reader mismatch cannot be replaced with matching caller rows',async()=>{
 const f=fixture(),e=await event();f.register(e);
 await assert.rejects(f.make({verifySnapshot:async locator=>{assert.equal(locator.rows,undefined);assert.equal(locator.rowsJson,undefined);return {...locator,rowsJson:'[]'};}}).observe(e));
 const other=await event([task(99)]);f.register(other);
 await assert.rejects(f.make({verifySnapshot:async()=>({namespace:e.namespace,agent:e.agent,sourceTable:e.sourceTable,selection:e.selection,rowsJson:other.rowsJson})}).observe(e),/snapshot_not_independently_verified/);
 assert.equal(f.count(),0);
});
test('actual store/capture/ledger preserve unknown fields, selected title and policy/meta bytes',async()=>{
 const f=fixture();
 for(const e of [await event([task(1,{unknown:{human_set_stage:'manual',manual_review:true},content:'Pre-agreement scouting outside ERP cards'})]),await event([chat(2)],'agent_chat_messages')]) {
  f.register(e);const result=await f.adapter.observe(e);assert.equal(result.status,'complete');assert.equal(result.cutoverReady,false);
  const row=result.rows[0];assert.equal(row.receipt,'verified');
  const snapshot=await f.store.readSnapshot(e.agent,row.manifestId);
  assert.equal(new TextDecoder().decode(snapshot.bytes),JSON.stringify(e.rows[0]));
  assert.equal(snapshot.manifest.source_revision,`nightly-snapshot:${e.snapshotSha256}`);
  const receipt=f.sql.prepare('SELECT * FROM pilot_export_destination_receipts WHERE manifest_id=?').get(row.manifestId);
  assert.equal(receipt.source_row_id,e.rows[0].id);
 }
});
test('same event exact replay and concurrent observations are idempotent; observedAt is not revision',async()=>{
 const f=fixture(),e=await event([task(),task(2)]);f.register(e);
 const values=await Promise.all([f.adapter.observe(e),f.adapter.observe(e)]);assert.ok(values.every(v=>v.status==='complete'));
 const replay=await f.adapter.observe({...e,observedAt:'2026-11-06T10:00:00.000Z'});assert.ok(replay.rows.every(r=>r.captureReplay&&r.receiptReplay));
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,2);
});
test('lost manifest response stops with unknown, later rows not attempted, exact explicit replay reconciles',async()=>{
 const f=fixture(),e=await event([task(),task(2)]);f.register(e);f.faults.manifestAfter=true;
 const first=await f.adapter.observe(e);assert.equal(first.status,'partial-or-unknown');assert.equal(first.rows[0].capture,'unknown');assert.equal(first.rows[0].receipt,'not-attempted');assert.equal(first.rows[1].capture,'not-attempted');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,0);
 f.faults.manifestAfter=false;const replay=await f.adapter.observe(e);assert.equal(replay.status,'complete');assert.equal(replay.rows[0].captureReplay,true);
});
test('lost receipt response is unknown not complete; exact replay reconciles without source restart',async()=>{
 const f=fixture(),e=await event([task(),task(2)]);f.register(e);f.faults.receiptAfter=true;
 const first=await f.adapter.observe(e);assert.equal(first.status,'partial-or-unknown');assert.equal(first.rows[0].capture,'verified');assert.equal(first.rows[0].receipt,'unknown');assert.equal(first.rows[1].capture,'not-attempted');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,1);
 f.faults.receiptAfter=false;const replay=await f.adapter.observe(e);assert.equal(replay.status,'complete');assert.equal(replay.rows[0].receiptReplay,true);
});
test('R2 or pre-insert failure remains uncertain and is never internally retried',async()=>{
 const f=fixture(),e=await event();f.register(e);f.faults.r2=true;
 const r=await f.adapter.observe(e);assert.equal(r.status,'partial-or-unknown');assert.equal(r.rows[0].capture,'unknown');assert.equal(f.count(),0);
 f.faults.r2=false;f.faults.receiptBefore=true;
 const next=await f.adapter.observe(e);assert.equal(next.rows[0].receipt,'unknown');assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_export_destination_receipts').get().n,0);
});
test('limits, non-JSON values and unsafe integers fail before writes',async()=>{
 const f=fixture(),e=await event();f.register(e);
 await assert.rejects(f.adapter.observe({...e,rowsJson:'x'.repeat(1048577)}),/snapshot_byte_limit/);
 await assert.rejects(f.adapter.observe({...e,rows:Array.from({length:501},(_,i)=>task(i+1))}),/snapshot_row_limit/);
 await assert.rejects(f.adapter.observe({...e,rows:[task(1,{future:9007199254740992})]}),/unsafe_snapshot_number/);
 const accessor=task();Object.defineProperty(accessor,'secret',{enumerable:true,get(){throw Error('must not execute');}});
 await assert.rejects(f.adapter.observe({...e,rows:[accessor]}),/invalid_snapshot_object/);
 await assert.rejects(f.adapter.observe({...e,rows:[task(1,{future:'x'.repeat(1048577)})]}),/snapshot_structure_limit/);
 assert.equal(f.count(),0);
});
test('caller mutation while verifier waits cannot change archived selected bytes',async()=>{
 const f=fixture(),e=await event();f.register(e);let release,entered;
 const started=new Promise(r=>entered=r), wait=new Promise(r=>release=r);
 const adapter=f.make({verifySnapshot:async()=>{entered();await wait;return {namespace:config.namespace,agent:'diana-helios',sourceTable:'org_task_runs',selection:e.selection,rowsJson:JSON.stringify(canonical([task()]))};}});
 const pending=adapter.observe(e);await started;e.rows[0].status='done';e.rowsJson='[]';release();const r=await pending;
 assert.equal(r.status,'complete');const read=await f.store.readSnapshot('diana-helios',r.rows[0].manifestId);assert.equal(JSON.parse(new TextDecoder().decode(read.bytes)).status,'missed');
});
test('verified prefix survives later row uncertainty and later rows remain unattempted',async()=>{
 const f=fixture(),e=await event([task(),task(2),task(3)]);f.register(e);let calls=0;
 const capture={captureD1Row:async(...args)=>{const r=await f.capture.captureD1Row(...args);if(++calls===2)throw Error('second response lost');return r;}};
 const report=await f.make({capture}).observe(e);
 assert.equal(report.status,'partial-or-unknown');assert.equal(report.rows[0].receipt,'verified');assert.equal(report.rows[1].capture,'unknown');assert.equal(report.rows[2].capture,'not-attempted');assert.equal(calls,2);
 const replay=await f.adapter.observe(e);assert.equal(replay.status,'complete');assert.equal(replay.rows[0].receiptReplay,true);assert.equal(replay.rows[1].captureReplay,true);
});
test('caller timeout cannot turn pending verification into adapter completion',async()=>{
 const f=fixture(),e=await event();f.register(e);let release;
 const wait=new Promise(r=>release=r);
 const adapter=f.make({verifySnapshot:async()=>{await wait;return {namespace:e.namespace,agent:e.agent,sourceTable:e.sourceTable,selection:e.selection,rowsJson:e.rowsJson};}});
 const pending=adapter.observe(e);
 const boundary=await Promise.race([pending,new Promise(r=>setTimeout(()=>r('unknown'),5))]);
 assert.equal(boundary,'unknown');assert.equal(f.count(),0);release();assert.equal((await pending).status,'complete');
});
