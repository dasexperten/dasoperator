import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const out=await build({entryPoints:[fileURLToPath(new URL('./diana-direct-dispatch.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {dispatchDianaDirect}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const at=Date.parse('2026-11-11T09:00:00+03:00');
function fixture(t){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 const DB={prepare(q){let v=[];const p={bind(...args){v=args;return p;},async first(){return sql.prepare(q).get(...v)??null},async all(){return {results:sql.prepare(q).all(...v)}},async run(){return {meta:{changes:Number(sql.prepare(q).run(...v).changes)}}}};return p;}};
 const created=[];const env={DB,DIANA_DIRECT:{async create(input){created.push(input)}}};
 const set=(key,value)=>sql.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)').run(key,JSON.stringify(value),at);
 const signal={cid:'chat',message_id:'m1',event_id:'message:m1',handle:'creator',at:new Date(at).toISOString(),reason:'new_message'};
 set('diana_round_alarm:chat',signal);return {env,sql,set,signal,created};
}
test('dispatches one metadata-only signal and prevents concurrent starts',async t=>{const f=fixture(t);assert.equal((await dispatchDianaDirect(f.env,undefined,at)).dispatched,true);assert.equal(f.created.length,1);assert.equal(f.created[0].params.events[0].message_id,'m1');assert.ok(!('text' in f.created[0].params.events[0]));assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'diana_cloud_working');});
test('payout and uncertain delivery remain pending and are not redispatched',async t=>{for(const reason of ['payout_handoff_pending','delivery_unknown']){const f=fixture(t);f.set('diana_direct_event:message:m1',{status:'pending',reason});assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'no_direct_signal_ready');assert.equal(f.created.length,0);}});
test('unavailable attachment waits three minutes and stops after the third attempt',async t=>{const f=fixture(t);f.set('diana_direct_event:message:m1',{status:'pending',reason:'original_attachment_unavailable',attempt:1,retry_at:at+180000});assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'media_retry_waiting');assert.equal((await dispatchDianaDirect(f.env,undefined,at+180000)).dispatched,true);assert.equal(f.created[0].params.events[0].attempt,2);});
test('uncertain creation holds the claim and cannot create a duplicate',async t=>{const f=fixture(t);f.env.DIANA_DIRECT.create=async()=>{throw Error('unknown')};assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'workflow_creation_unknown');assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'diana_cloud_working');});
test('terminal workflow without receipt is held for review and releases only its exact lock',async t=>{
 const f=fixture(t);await dispatchDianaDirect(f.env,undefined,at);const id=f.created[0].id;
 f.env.DIANA_DIRECT.get=async()=>({status:async()=>({status:'errored'})});
 const result=await dispatchDianaDirect(f.env,undefined,at+181000);
 assert.equal(result.reason,'no_direct_signal_ready');assert.equal(f.created.length,1);
 const review=JSON.parse(f.sql.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_direct_event:message:m1').value);
 assert.equal(review.reason,'terminal_workflow_without_verified_receipt');assert.equal(review.review_owner,'diana-helios');
 assert.equal(f.sql.prepare("SELECT value FROM crm_sync_state WHERE key='diana_direct_active'").get(),undefined);
});
test('unreachable workflow never releases an uncertain lock by age alone',async t=>{
 const f=fixture(t);await dispatchDianaDirect(f.env,undefined,at);f.env.DIANA_DIRECT.get=async()=>{throw Error('unavailable')};
 assert.equal((await dispatchDianaDirect(f.env,undefined,at+181000)).reason,'workflow_status_unknown');assert.equal(f.created.length,1);
});
test('one cloud invocation batches four distinct incoming conversations without message content',async t=>{
 const f=fixture(t);for(let n=2;n<=5;n++){const id='m'+n;f.set('diana_round_alarm:chat'+n,{cid:'chat'+n,message_id:id,event_id:'message:'+id,handle:'creator'+n,at:new Date(at-n*1000).toISOString()});}
 const out=await dispatchDianaDirect(f.env,undefined,at);assert.equal(out.dispatched,true);assert.equal(out.event_ids.length,4);assert.equal(f.created.length,1);assert.equal(f.created[0].params.events.length,4);assert.equal(new Set(f.created[0].params.events.map(e=>e.cid)).size,4);assert.ok(f.created[0].params.events.every(e=>!('text' in e)));
});
test('terminal batch without receipts flags each unresolved signal for review',async t=>{
 const f=fixture(t);f.set('diana_round_alarm:second',{cid:'second',message_id:'m2',event_id:'message:m2',at:new Date(at).toISOString()});await dispatchDianaDirect(f.env,undefined,at);f.env.DIANA_DIRECT.get=async()=>({status:async()=>({status:'errored'})});await dispatchDianaDirect(f.env,undefined,at+181000);
 for(const id of ['message:m1','message:m2']){const row=f.sql.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_direct_event:'+id);assert.equal(JSON.parse(row.value).status,'needs_review');}assert.equal(f.created.length,1);
});
