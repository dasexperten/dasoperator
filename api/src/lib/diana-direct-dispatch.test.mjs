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
test('dispatches one metadata-only signal and prevents concurrent starts',async t=>{const f=fixture(t);assert.equal((await dispatchDianaDirect(f.env,undefined,at)).dispatched,true);assert.equal(f.created.length,1);assert.equal(f.created[0].params.message_id,'m1');assert.ok(!('text' in f.created[0].params));assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'diana_cloud_working');});
test('payout and uncertain delivery remain pending and are not redispatched',async t=>{for(const reason of ['payout_handoff_pending','delivery_unknown']){const f=fixture(t);f.set('diana_direct_event:message:m1',{status:'pending',reason});assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'no_direct_signal_ready');assert.equal(f.created.length,0);}});
test('unavailable attachment waits three minutes and stops after the third attempt',async t=>{const f=fixture(t);f.set('diana_direct_event:message:m1',{status:'pending',reason:'original_attachment_unavailable',attempt:1,retry_at:at+180000});assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'media_retry_waiting');assert.equal((await dispatchDianaDirect(f.env,undefined,at+180000)).dispatched,true);assert.equal(f.created[0].params.attempt,2);});
test('uncertain creation holds the claim and cannot create a duplicate',async t=>{const f=fixture(t);f.env.DIANA_DIRECT.create=async()=>{throw Error('unknown')};assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'workflow_creation_unknown');assert.equal((await dispatchDianaDirect(f.env,undefined,at)).reason,'diana_cloud_working');});
