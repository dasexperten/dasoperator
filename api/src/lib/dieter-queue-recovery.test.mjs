import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
const dir=mkdtempSync(join(tmpdir(),'dieter-recovery-')),file=join(dir,'recovery.mjs');
await build({entryPoints:[fileURLToPath(new URL('./dieter-queue-recovery.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent'});
const {recoverDieterQueue,announceDieterRuntimeStop,flushDieterQueueNotices}=await import(pathToFileURL(file));rmSync(dir,{recursive:true});
const STOP='dieter_cloud_runtime_stop',RECOVERY='dieter_queue_recovery:claim';
const good=()=>({ready:true,activation_ready:true,native_tools_verified:true,drive:{ready:true},receipt:{transport:'codex-native',auth:'subscription',model:'gpt-6.1-terra',mode:'preflight'}});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_reel_jobs(content_id TEXT PRIMARY KEY,status TEXT,attempts INTEGER,claim_id TEXT,publications TEXT);
 INSERT INTO ugc_reel_jobs VALUES('failed','queued',2,'claim','[{"platform":"tiktok","publish_id":"accepted"}]'),('next','queued',0,NULL,'[]');`);
 const put=(k,v)=>db.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,0)').run(k,typeof v==='string'?v:JSON.stringify(v));
 const raw=k=>db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(k)?.value;
 const get=k=>raw(k)?JSON.parse(raw(k)):undefined;
 const stop={kind:'runtime_incident_stop',claim_id:'claim',content_id:'failed',automatic_retry:false};
 put('dieter_cloud_mode','enabled');put(STOP,stop);put('dieter_cloud_assignment:claim',{claim_id:'claim',content_id:'failed',workflow_id:'dieter-claim'});
 const sends=[];let status='complete',calls=0,delivery=true;
 const env={DB:{prepare(sql){let args=[];const st={bind(...a){args=a;return st;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};}};return st;}},DASORG_API_KEY:'fixture',ORGANIZATION:{async fetch(_url,init){sends.push(JSON.parse(init.body));return Response.json(delivery?{ok:true,message_id:sends.length}:{ok:false});}},DIETER_CLOUD:{async get(id){assert.equal(id,'dieter-claim');return {async status(){if(status==='unknown')throw Error('unavailable');return {status};}};}}};
 const check=async()=>{calls++;return good();};
 return {db,env,put,get,raw,stop,sends,check,calls:()=>calls,status:s=>status=s,delivery:v=>delivery=v,run:(fn=check,now=1000)=>recoverDieterQueue(env,fn,now)};
}
test('healthy and disabled clocks perform no readiness calls or notifications',async t=>{
 const f=fixture(t);f.db.prepare('DELETE FROM crm_sync_state WHERE key=?').run(STOP);
 assert.equal((await f.run()).status,'healthy');f.put('dieter_cloud_mode','disabled');assert.equal((await f.run()).status,'disabled');assert.equal(f.calls(),0);assert.equal(f.sends.length,0);
});
test('terminal incident resumes only the shared queue and preserves every upload proof, counter and individual hold',async t=>{
 const f=fixture(t),before=f.db.prepare('SELECT * FROM ugc_reel_jobs ORDER BY content_id').all();
 assert.equal((await f.run()).status,'recovered');assert.equal(f.raw(STOP),undefined);assert.deepEqual(f.get('dieter_cloud_execution_hold:failed'),f.stop);
 assert.deepEqual(f.db.prepare('SELECT * FROM ugc_reel_jobs ORDER BY content_id').all(),before);assert.equal(f.get(RECOVERY).provider_publish_calls,0);assert.equal(f.calls(),1);assert.equal(f.sends.length,1);
 assert.equal((await f.run()).status,'healthy');assert.equal(f.calls(),1);assert.equal(f.sends.length,1);
});
test('running and unknown original workflows never allow a second claim',async t=>{
 const f=fixture(t);f.status('running');assert.equal((await f.run()).status,'waiting');assert.equal(f.calls(),0);
 f.status('unknown');await f.run();await f.run();assert.equal(f.calls(),0);assert.ok(f.raw(STOP));assert.equal(f.sends.length,1);
});
test('terminal workflow with an unreconciled working job is held and reported once',async t=>{
 const f=fixture(t);f.db.exec("UPDATE ugc_reel_jobs SET status='working' WHERE content_id='failed'");
 assert.equal((await f.run()).reason,'active_claim_requires_reconciliation');await f.run();assert.equal(f.calls(),0);assert.equal(f.sends.length,1);assert.ok(f.raw(STOP));
});
test('three transient probes are a durable total across clocks; fourth is forbidden',async t=>{
 const f=fixture(t);let calls=0;const unavailable=async()=>{calls++;throw Error('{"error":"native_runner_unavailable"}');};
 assert.equal((await f.run(unavailable,1000)).status,'waiting');await f.run(unavailable,2000);assert.equal(calls,1);
 await f.run(unavailable,181000);assert.equal(calls,2);assert.equal((await f.run(unavailable,361000)).status,'blocked');
 await f.run(unavailable,9999999);assert.equal(calls,3);assert.equal(f.get(RECOVERY).attempts,3);assert.equal(f.sends.length,1);assert.ok(f.raw(STOP));
});
test('exhausted preflight never receives a fourth attempt from recovery',async t=>{
 const f=fixture(t);f.put('dieter_cloud_preflight_blocked',{reason:'native_runner_unavailable',failed_attempts:3});
 await f.run();await f.run();assert.equal(f.calls(),0);assert.equal(f.sends.length,1);assert.equal(f.get('dieter_cloud_preflight_blocked').failed_attempts,3);
});
test('nontransient failures and missing source/tool receipts stop after one probe',async t=>{
 for(const check of [async()=>{throw Error('subscription_auth_not_seeded');},async()=>({...good(),drive:{ready:false}}),async()=>({...good(),receipt:{mode:'work'}})]){
 const f=fixture(t);let calls=0;const run=()=>f.run(async()=>{calls++;return check();});assert.equal((await run()).status,'blocked');await run();assert.equal(calls,1);assert.ok(f.raw(STOP));assert.equal(f.sends.length,1);
 }
});
test('a changed incident or owner pause during the slow probe cannot be cleared',async t=>{
 for(const change of [f=>f.put(STOP,{...f.stop,claim_id:'new-claim'}),f=>f.put('dieter_cloud_mode','disabled')]){
 const f=fixture(t);await f.run(async()=>{change(f);return good();});assert.ok(f.raw(STOP));assert.equal(f.sends.length,0);
 }
});
test('an interrupted probe cannot be replayed by a restarted handler',async t=>{
 const f=fixture(t);f.put(RECOVERY,{state:'checking',attempts:1,stop:f.raw(STOP),workflow_id:'dieter-claim'});
 assert.equal((await f.run()).reason,'probe_outcome_unknown');await f.run();assert.equal(f.calls(),0);assert.equal(f.sends.length,1);assert.ok(f.raw(STOP));
});
test('owner holds and incomplete assignments never trigger readiness or publication',async t=>{
 const f=fixture(t);f.put(STOP,{...f.stop,owner_hold:true});assert.equal((await f.run()).status,'owner_hold');
 f.put(STOP,f.stop);f.put('dieter_cloud_assignment:claim',{claim_id:'wrong'});assert.equal((await f.run()).reason,'assignment_unconfirmed');assert.equal(f.calls(),0);assert.equal(f.sends.length,1);
});
test('failed notification delivery is retried with a persistent three-attempt ceiling',async t=>{
 const f=fixture(t);f.delivery(false);await announceDieterRuntimeStop(f.env,f.stop);const first=f.sends.length;assert.equal(first,1);
 await flushDieterQueueNotices(f.env,Date.now()+181000);await flushDieterQueueNotices(f.env,Date.now()+362000);await flushDieterQueueNotices(f.env,Date.now()+9999999);assert.equal(f.sends.length,3);
 const notice=f.db.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_queue_notice:claim:blocked'").get();assert.equal(JSON.parse(notice.value).state,'delivery_failed');
});
