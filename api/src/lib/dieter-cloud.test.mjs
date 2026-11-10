import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild'),dir=mkdtempSync(join(tmpdir(),'dieter-cloud-')),file=join(dir,'cloud.mjs');
await build({entryPoints:[fileURLToPath(new URL('../dieter-cloud.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:file,plugins:[{name:'runtime',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'runtime',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export class WorkflowEntrypoint{}'}));}}]});
const {DieterWake,preflightDieter,DieterCloudWorkflow}=await import(pathToFileURL(file));
const transportFile=join(dir,'transport.mjs');await build({entryPoints:[fileURLToPath(new URL('../dieter-tiktok-workflow.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:transportFile,logLevel:'silent'});
const {scheduleDieterTikTokTransport}=await import(pathToFileURL(transportFile));
const timingFile=join(dir,'timing.mjs');await build({entryPoints:[fileURLToPath(new URL('./dieter-flow-timing.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:timingFile,logLevel:'silent'});
const {dieterFlowTiming,saveDieterFlowTiming}=await import(pathToFileURL(timingFile));rmSync(dir,{recursive:true});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_reel_jobs(content_id TEXT PRIMARY KEY,status TEXT,attempts INTEGER,requested_at TEXT,claim_id TEXT,consumer_id TEXT,started_at TEXT,acknowledged_at TEXT,last_error TEXT,updated_at TEXT);
 INSERT INTO ugc_reel_jobs(content_id,status,attempts,requested_at) VALUES('one','queued',0,'2026-11-09'),('two','queued',0,'2026-11-10');
 INSERT INTO crm_sync_state VALUES('dieter_cloud_mode','enabled',0);`);
 const env={DB:{prepare(sql){let args=[];const st={bind(...a){args=a;return st;},async first(){return db.prepare(sql).get(...args)??null;},async run(){return {meta:{changes:db.prepare(sql).run(...args).changes}};}};return st;}},
 DIETER_SUBSCRIPTION:{async fetch(){return Response.json({text:JSON.stringify({ready:true,activation_ready:true,org_sha:'fixture',tools:{}})});}},DIETER_CLOUD:{async create(p){created.push(p);},async get(){return{async status(){if(missing)throw Error('not found');return{status:'running'};}};}}};
 const created=[];let missing=false;const wake=new DieterWake({},env),now=Date.parse('2026-11-10T05:00:00Z');t.mock.method(Date,'now',()=>now);
 const request=()=>new Request('https://dieter.internal/dispatch',{method:'POST',body:JSON.stringify({now})});
 return {db,env,created,wake,request,missing(){missing=true;}};
}
test('overlapping cloud ticks accept only one real job and preserve the next red job',async t=>{
 const f=fixture(t);const r=await Promise.all([f.wake.fetch(f.request()),f.wake.fetch(f.request())]);const results=await Promise.all(r.map(r=>r.json()));
 assert.equal(results.filter(x=>x.accepted).length,1);assert.equal(f.created.length,1);assert.equal(f.db.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='two'").get().status,'queued');
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,1);
});
test('an unavailable cloud runtime never makes a red job yellow',async t=>{
 const f=fixture(t);f.env.DIETER_SUBSCRIPTION.fetch=async()=>Response.json({error:'unavailable'},{status:503});await assert.rejects(f.wake.fetch(f.request()),/unavailable/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ugc_reel_jobs WHERE status='working'").get().n,0);assert.equal(f.created.length,0);
});
test('read-only preflight recovers one container HTTP failure without claiming a job',async t=>{
 const f=fixture(t);let calls=0;const ids=[];
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{const body=JSON.parse(init.body);ids.push(body.requestId);assert.equal(body.execution.mode,'preflight');return ++calls===1?Response.json({error:'native_runner_unavailable'},{status:503}):Response.json({text:JSON.stringify({ready:true,activation_ready:true})});};
 assert.equal((await preflightDieter(f.env,async()=>{})).activation_ready,true);assert.equal(calls,2);assert.equal(new Set(ids).size,2);
 assert.equal(f.created.length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM ugc_reel_jobs WHERE status='working'").get().n,0);
});
test('preflight container recovery stops after three calls; auth failures are not retried',async t=>{
 const f=fixture(t);let calls=0;
 f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;return Response.json({error:'native_runner_unavailable'},{status:503});};
 await assert.rejects(preflightDieter(f.env,async()=>{}),/native_runner_unavailable/);assert.equal(calls,3);
 await assert.rejects(preflightDieter(f.env,async()=>{}),/blocked_after_three/);assert.equal(calls,3);
 assert.equal((await(await f.wake.fetch(f.request())).json()).note,'preflight_blocked_after_three_failures');assert.equal(calls,3);
 f.db.prepare("DELETE FROM crm_sync_state WHERE key='dieter_cloud_preflight_blocked'").run();
 calls=0;f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;return Response.json({error:'subscription_auth_not_seeded'},{status:503});};
 await assert.rejects(preflightDieter(f.env,async()=>{}),/subscription_auth_not_seeded/);assert.equal(calls,1);
 assert.equal(f.created.length,0);
});
test('lost create acknowledgement recovers the same claim and instance without another attempt',async t=>{
 const f=fixture(t);await f.wake.fetch(f.request());const original=f.created[0];f.missing();await f.wake.fetch(f.request());assert.equal(f.created.length,2);assert.deepEqual(f.created[1],original);
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,1);
});
test('disabled cloud mode cannot claim work',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE crm_sync_state SET value='disabled'").run();assert.equal((await(await f.wake.fetch(f.request())).json()).note,'cloud_disabled');assert.equal(f.created.length,0);
});

test('Drive source readiness needs company identity, write scope and the exact originals folder',async()=>{
 const {probeDrive}=await import('../../subscription-runner/dieter.mjs');assert.equal((await probeDrive(null)).ready,false);
 const credential={client_id:'fixture',client_secret:'fixture',refresh_token:'fixture'};
 let count=0;const call=async()=>Response.json([ {access_token:'fixture',scope:'https://www.googleapis.com/auth/drive.readonly'}, {}, {} ][count++]);
 assert.equal((await probeDrive(credential,call)).reason,'drive_write_scope_missing');assert.equal(count,1);
 count=0;const wrong=async()=>Response.json([{access_token:'fixture',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'}, {user:{emailAddress:'other@example.com'}}][count++]);
 assert.equal((await probeDrive(credential,wrong)).reason,'drive_company_account_not_verified');assert.equal(count,2);
 count=0;const good=async()=>Response.json([{access_token:'fixture',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'}, {user:{emailAddress:'dasexperten@gmail.com'}},{id:'13fAh0oFKq_PCUkL0iG8WIOpHfPN8vM39',name:'originals',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}}][count++]);
 assert.equal((await probeDrive(credential,good)).ready,true);
});
test('private runtime audit cannot persist shell text or credential-bearing errors',async()=>{
 const {auditDieterEvents}=await import('../../subscription-runner/dieter.mjs');
 const audit=auditDieterEvents([{type:'item.completed',item:{type:'command_execution',command:'echo secret-fixture',aggregated_output:'secret-fixture',exit_code:0,status:'completed'}},{type:'turn.failed',error:{message:'secret-fixture'}}]);
 assert.ok(!audit.includes('secret-fixture'));assert.ok(audit.includes('command_execution'));assert.ok(audit.includes('"exit_code":0'));
});

test('an older wider company grant cannot activate the uploader',async()=>{
 const {probeDrive}=await import('../../subscription-runner/dieter.mjs');let calls=0;
 const result=await probeDrive({client_id:'fixture',client_secret:'fixture',refresh_token:'fixture'},async()=>{calls++;return Response.json({access_token:'fixture',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.modify'});});
 assert.equal(result.ready,false);assert.equal(result.reason,'drive_scope_exceeds_approved_permissions');assert.equal(calls,1);
});

function workflowFixture(t){
 const f=fixture(t);
 f.db.exec(`ALTER TABLE ugc_reel_jobs ADD COLUMN published_at TEXT;
 ALTER TABLE ugc_reel_jobs ADD COLUMN publications TEXT DEFAULT '[]';
 ALTER TABLE ugc_reel_jobs ADD COLUMN required_destinations TEXT DEFAULT '["instagram","threads","youtube","facebook","vk","rutube","tiktok"]';
 CREATE TABLE ugc_content(id TEXT PRIMARY KEY,creator_platform_id TEXT,content_url TEXT);
 CREATE TABLE ugc_creator_platforms(id TEXT PRIMARY KEY,handle TEXT);
 INSERT INTO ugc_creator_platforms VALUES('creator','actual_author');
 INSERT INTO ugc_content VALUES('one','creator','https://instagram.com/reel/SOURCE/');
 UPDATE ugc_reel_jobs SET status='working',attempts=2,claim_id='exact-claim',consumer_id='cloudflare-dieter-v1',started_at='2026-11-10T05:00:00Z' WHERE content_id='one';`);
 f.env.DOCS={async put(){}};
 const workflow=new DieterCloudWorkflow();workflow.env=f.env;
 const event={payload:{content_id:'one',claim_id:'exact-claim'},instanceId:'dieter-exact-claim'};
 const step={async do(_name,options,callback){return (typeof options==='function'?options:callback)();}};
 return {...f,workflow,event,step};
}
test('actual Workflow preserves work failure after successful reconciliation, holds runtime and never invents claim attempts',async t=>{
 const f=workflowFixture(t),modes=[];
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{
  const body=JSON.parse(init.body);modes.push(body.execution.mode);
  return modes.length<3?Response.json({error:'native_runner_unavailable',diagnostic:{phase:'container_proxy',code:'http_unavailable',message:'secret-fixture'}},{status:503}):Response.json({text:'Reconciliation finished; no verified posts'});
 };
 const result=await f.workflow.run(f.event,f.step);
 assert.deepEqual(modes,['work','reconcile','reconcile']);
 assert.equal(result.publication_verified,false);assert.equal(result.runtime_completed,true);assert.equal(result.work_runtime_completed,false);assert.equal(result.reconciliation_completed,true);
 assert.equal(result.material_result,'not_assessed');assert.equal(result.execution_result,'runtime_error');assert.equal(result.first_work_failure.error,'native_runner_unavailable');
 assert.deepEqual(result.first_work_failure.diagnostic,{phase:'container_proxy',code:'http_unavailable'});
 const row=f.db.prepare("SELECT * FROM ugc_reel_jobs WHERE content_id='one'").get();assert.equal(row.attempts,2);assert.equal(row.status,'queued');assert.match(row.last_error,/Cloud runtime: native_runner_unavailable/);
 const read=key=>JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(key).value);
 assert.equal(read('dieter_cloud_runtime_stop').first_failure.mode,'work');assert.equal(read('dieter_cloud_execution_hold:one').automatic_retry,false);
 assert.equal(read('dieter_cloud_result:exact-claim').first_work_failure.mode,'work');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'dieter_cloud_attempt:%'").get().n,6);
 assert.ok(!JSON.stringify(f.db.prepare('SELECT value FROM crm_sync_state').all()).includes('secret-fixture'));
 assert.equal((await(await f.wake.fetch(f.request())).json()).note,'runtime_incident_stop');
 await assert.rejects(preflightDieter(f.env),/runtime_incident_stop/);assert.equal(modes.length,3);assert.equal(f.created.length,0);
});
test('a persisted intent without outcome is never replayed after Workflow restart; only existing bounded reconciliation calls run',async t=>{
 const f=workflowFixture(t),modes=[];
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_attempt:exact-claim:0:intent',JSON.stringify({claim_id:'exact-claim',mode:'work',request_id:'dieter-exact-claim-0'}));
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{modes.push(JSON.parse(init.body).execution.mode);return Response.json({text:'Read-only reconciliation'});};
 const result=await f.workflow.run(f.event,f.step);
 assert.deepEqual(modes,['reconcile','reconcile']);assert.equal(result.first_work_failure.error,'native_call_outcome_unknown');
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,2);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key='dieter_cloud_attempt:exact-claim:0:intent'").get().n,1);
});
test('global runtime stop is enforced before busy Workflow recovery, including after a fresh Wake object',async t=>{
 const f=workflowFixture(t);f.missing();
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{"kind":"runtime_incident_stop"}');
 const restarted=new DieterWake({},f.env);assert.equal((await(await restarted.fetch(f.request())).json()).note,'runtime_incident_stop');assert.equal(f.created.length,0);
});
test('actual Workflow exact-claim guard rejects a different assignment before native effects',async t=>{
 const f=workflowFixture(t);let calls=0;f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;return Response.json({text:'unused'});};
 await assert.rejects(f.workflow.run({...f.event,payload:{content_id:'one',claim_id:'other-claim'}},f.step),/exact_claim_missing/);
 assert.equal(calls,0);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'dieter_cloud_attempt:%'").get().n,0);
});

test('an execution hold prevents busy-instance recovery even when the shared runtime stop is cleared',async t=>{
 const f=workflowFixture(t);f.missing();f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_execution_hold:one','{"kind":"runtime_incident_stop"}');
 assert.equal((await(await f.wake.fetch(f.request())).json()).note,'execution_requires_reconciliation');assert.equal(f.created.length,0);
});
test('a runtime stop appearing during read-only preflight prevents the later atomic claim',async t=>{
 const f=fixture(t);
 f.env.DIETER_SUBSCRIPTION.fetch=async()=>{f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{"kind":"runtime_incident_stop"}');return Response.json({text:'{"ready":true,"activation_ready":true}'});};
 assert.equal((await(await f.wake.fetch(f.request())).json()).note,'runtime_incident_stop');assert.equal(f.created.length,0);
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,0);
});
test('duplicate execution callbacks reuse each immutable request outcome without another native call',async t=>{
 const f=workflowFixture(t),ids=[];
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{const b=JSON.parse(init.body);ids.push(b.requestId);return ids.length===1?Response.json({error:'native_runner_unavailable'},{status:503}):Response.json({text:'Read-only reconciliation'});};
 const twice={async do(_name,options,callback){const fn=typeof options==='function'?options:callback;await fn();return fn();}};
 const result=await f.workflow.run(f.event,twice);assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.equal(result.first_work_failure.error,'native_runner_unavailable');
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'dieter_cloud_attempt:%'").get().n,6);
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,2);
});

test('restart after failure outcome commit recreates a missing stop and hold without replaying work',async t=>{
 const f=workflowFixture(t),modes=[];
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_attempt:exact-claim:0:intent','{"claim_id":"exact-claim","mode":"work"}');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_attempt:exact-claim:0:outcome','{"claim_id":"exact-claim","mode":"work","outcome":"runtime_error","error":"native_runner_unavailable"}');
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{modes.push(JSON.parse(init.body).execution.mode);return Response.json({text:'Only reconciliation'});};
 const result=await f.workflow.run(f.event,f.step);assert.deepEqual(modes,['reconcile','reconcile']);assert.equal(result.first_work_failure.error,'native_runner_unavailable');
 assert.ok(f.db.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_runtime_stop'").get());assert.ok(f.db.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_execution_hold:one'").get());
 assert.equal((await(await f.wake.fetch(f.request())).json()).note,'runtime_incident_stop');
});
test('verified public proofs found during reconciliation accept publication while preserving the earlier runtime incident',async t=>{
 const f=workflowFixture(t);let calls=0;
 const urls={instagram:'https://instagram.com/reel/OUTFIXTURE/',threads:'https://threads.com/@dasexperten/post/FIXTURE',youtube:'https://youtube.com/watch?v=AbC123def_0',facebook:'https://facebook.com/reel/1234567890/',vk:'https://vk.ru/video-229095983_456240575',rutube:'https://rutube.ru/video/0123456789abcdef0123456789abcdef/',tiktok:'https://tiktok.com/@dasbroadcast/video/1234567890'};
 const proofs=Object.entries(urls).map(([platform,url])=>({platform,url,account:platform==='tiktok'?'dasbroadcast':'dasexperten',verified:true,verified_at:'2026-11-10T05:00:00Z',evidence:'Verified public fixture during reconciliation'}));
 f.env.DIETER_SUBSCRIPTION.fetch=async()=>{if(++calls===1)return Response.json({error:'native_runner_unavailable'},{status:503});f.db.prepare("UPDATE ugc_reel_jobs SET status='published',publications=? WHERE content_id='one'").run(JSON.stringify(proofs));return Response.json({text:'All seven genuine proofs saved'});};
 const result=await f.workflow.run(f.event,f.step);assert.equal(result.publication_verified,true);assert.equal(result.execution_result,'publication_verified');assert.equal(result.material_result,'published');assert.equal(result.runtime_incident_present,true);assert.equal(result.first_work_failure.error,'native_runner_unavailable');assert.equal(calls,2);
 assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,2);
});
test('disabled runtime preserves the exact working claim and records explicit reconciliation-only continuation',async t=>{
 const f=workflowFixture(t);let calls=0;f.db.prepare("UPDATE crm_sync_state SET value='disabled' WHERE key='dieter_cloud_mode'").run();f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;throw Error('must not call');};
 const result=await f.workflow.run(f.event,f.step);assert.equal(result.status,'paused');assert.equal(result.continuation_required,true);assert.equal(result.next_allowed_mode,'reconcile');assert.equal(result.retry_work,false);assert.equal(calls,0);
 const row=f.db.prepare("SELECT status,claim_id,attempts FROM ugc_reel_jobs WHERE content_id='one'").get();assert.equal(row.status,'working');assert.equal(row.claim_id,'exact-claim');assert.equal(row.attempts,2);
});

function continuationFixture(t){
 const f=workflowFixture(t),id='repair-one';
 f.db.exec("UPDATE ugc_reel_jobs SET status='queued',attempts=3,claim_id=NULL,started_at='2026-11-10T04:00:00Z' WHERE content_id='one'");
 f.env.DB.batch=async statements=>{f.db.exec('BEGIN');try{const results=[];for(const st of statements)results.push(await st.run());f.db.exec('COMMIT');return results;}catch(error){f.db.exec('ROLLBACK');throw error;}};
 for(const claim of ['old-one','exact-claim'])f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_assignment:'+claim,JSON.stringify({content_id:'one',claim_id:claim}));
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_execution_hold:one','{"kind":"runtime_incident_stop"}');
 const definition={state:'ready',content_id:'one',claim_id:'exact-claim',workflow_id:'dieter-continuation-'+id,owner_authorized:true,runtime_accepted:true,side_effect_assessment_accepted:true,raw_attempts:3,observed_work_rpcs:2,next_work_ordinal:3,remaining_work_after:0,previous_claim_ids:['old-one','exact-claim']};
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_continuation:'+id,JSON.stringify(definition));
 return {...f,id,definition,event:{payload:{content_id:'one',claim_id:'exact-claim',continuation_id:id},instanceId:definition.workflow_id}};
}
test('accepted repair continuation restores only the original claim, reserves final work once, and preserves raw counters and clocks',async t=>{
 const f=continuationFixture(t),calls=[];
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{const b=JSON.parse(init.body);calls.push(b);assert.equal(b.execution.assignment.claim_id,'exact-claim');assert.equal(b.execution.assignment.continuation.next_work_ordinal,3);assert.match(b.execution.assignment.task,/third and final work/);f.db.prepare("UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL WHERE content_id='one'").run();return Response.json({text:'Controlled work completed'});};
 await f.workflow.run(f.event,f.step);assert.equal(calls.length,1);assert.equal(calls[0].requestId,'dieter-continuation-repair-one-0');
 const row=f.db.prepare("SELECT attempts,started_at FROM ugc_reel_jobs WHERE content_id='one'").get();assert.equal(row.attempts,3);assert.equal(row.started_at,'2026-11-10T04:00:00Z');
 assert.ok(f.db.prepare("SELECT key FROM crm_sync_state WHERE key='dieter_cloud_work_ordinal:one:3'").get());
 const other={...f.definition,workflow_id:'dieter-continuation-repair-two'};f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_continuation:repair-two',JSON.stringify(other));
 await assert.rejects(f.workflow.run({payload:{...f.event.payload,continuation_id:'repair-two'},instanceId:other.workflow_id},f.step),/already_consumed/);assert.equal(calls.length,1);
});
test('repair continuation requires runtime acceptance and does not bypass a live incident stop',async t=>{
 const f=continuationFixture(t);let calls=0;f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;throw Error('must not infer');};
 f.db.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify({...f.definition,runtime_accepted:false}),'dieter_cloud_continuation:'+f.id);
 await assert.rejects(f.workflow.run(f.event,f.step),/not_authorized/);
 f.db.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify(f.definition),'dieter_cloud_continuation:'+f.id);
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{"kind":"runtime_incident_stop"}');
 await assert.rejects(f.workflow.run(f.event,f.step),/runtime_incident_stop/);assert.equal(calls,0);assert.equal(f.db.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='one'").get().status,'queued');
});
test('a lost continuation work intent permits one remaining read-only reconciliation and never repeats the final work',async t=>{
 const f=continuationFixture(t),modes=[];
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_attempt:exact-claim:continuation:repair-one:0:intent','{"mode":"work"}');
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{modes.push(JSON.parse(init.body).execution.mode);return Response.json({text:'Reconciliation only'});};
 const result=await f.workflow.run(f.event,f.step);assert.deepEqual(modes,['reconcile']);assert.equal(result.first_work_failure.error,'native_call_outcome_unknown');assert.equal(f.db.prepare("SELECT attempts FROM ugc_reel_jobs WHERE content_id='one'").get().attempts,3);
});

test('duplicate or invalid historical claim identities cannot authorize the final continuation',async t=>{
 const f=continuationFixture(t);let calls=0;f.env.DIETER_SUBSCRIPTION.fetch=async()=>{calls++;throw Error('must not infer');};
 for(const claims of [['exact-claim','exact-claim'],['','exact-claim']]){
  f.db.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify({...f.definition,previous_claim_ids:claims}),'dieter_cloud_continuation:'+f.id);
  await assert.rejects(f.workflow.run(f.event,f.step),/not_authorized/);
 }
 assert.equal(calls,0);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key='dieter_cloud_work_ordinal:one:3'").get().n,0);assert.equal(f.db.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='one'").get().status,'queued');
});

function transportFixture(t){
 const f=continuationFixture(t),sha='a'.repeat(64);
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_continuation:repair-one:started',JSON.stringify({workflow_id:f.definition.workflow_id}));
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_result:exact-claim:continuation:repair-one','{"work_runtime_completed":true}');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_work_ordinal:one:3','{"reserved":true}');
 const urls={instagram:'https://instagram.com/reel/OUTFIXTURE/',threads:'https://threads.com/@dasexperten/post/FIXTURE',youtube:'https://youtube.com/watch?v=AbC123def_0',facebook:'https://facebook.com/reel/1234567890/',vk:'https://vk.ru/video-229095983_456240575',rutube:'https://rutube.ru/video/0123456789abcdef0123456789abcdef/'};
 const proofs=Object.entries(urls).map(([platform,url])=>({platform,url,account:'dasexperten',verified:true,verified_at:'2026-11-10T05:00:00Z',evidence:'Verified fixture'}));
 f.db.prepare("UPDATE ugc_reel_jobs SET publications=? WHERE content_id='one'").run(JSON.stringify(proofs));
 return {...f,proofs,args:{contentId:'one',claimId:'exact-claim',sourceSha256:sha,sourceAssetUrl:'https://org.dasexperten.com/assets/ugc/'+sha+'/original.mp4',sourceDurationSeconds:13,sourceAuthor:'actual_author',sourceUrl:'https://instagram.com/reel/SOURCE/',sourceDriveId:'original-drive-file'}};
}
test('TikTok-only API Workflow finishes seven platforms without a native call, counter reset or replacing the six earlier proofs',async t=>{
 const f=transportFixture(t);let nativeCalls=0;f.env.DIETER_SUBSCRIPTION.fetch=async()=>{nativeCalls++;throw Error('native forbidden');};
 const scheduled=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');
 const proof={platform:'tiktok',url:'https://tiktok.com/@dasbroadcast/video/1234567890',account:'dasbroadcast',verified:true,verified_at:'2026-11-10T05:00:00Z',evidence:'API complete exact provider ID/caption/duration fixture'};
 const step={async do(name,options,callback){if(typeof options==='object'&&options.retries){assert.equal(typeof options.retries.delay,'string','Cloudflare retries.delay is required even for limit0');assert.ok(options.retries.delay.length>0);}if(name==='tiktok-publish-once'){f.db.prepare("UPDATE ugc_reel_jobs SET publications=? WHERE content_id='one'").run(JSON.stringify([...f.proofs,proof]));return {status:'verified',proof};}return (typeof options==='function'?options:callback)();},async sleep(){throw Error('not pending');}};
 const result=await f.workflow.run({payload:{content_id:'one',claim_id:'exact-claim',transport:'tiktok',transport_id:scheduled.transport_id},instanceId:scheduled.workflow_id},step);
 assert.equal(result.publication_verified,true);assert.equal(result.model_calls,0);assert.equal(nativeCalls,0);
 const row=f.db.prepare("SELECT * FROM ugc_reel_jobs WHERE content_id='one'").get();assert.equal(row.status,'published');assert.equal(row.attempts,3);assert.equal(row.started_at,'2026-11-10T04:00:00Z');assert.deepEqual(JSON.parse(row.publications).slice(0,6),f.proofs);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'dieter_cloud_attempt:%'").get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key='dieter_cloud_work_ordinal:one:3'").get().n,1);
});
test('TikTok-only API scheduling and activation respect the global stop and immutable source definition',async t=>{
 const f=transportFixture(t);f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{}');await assert.rejects(scheduleDieterTikTokTransport(f.env,f.args,'repair-one'),/runtime_incident_stop/);assert.equal(f.created.length,0);
 f.db.prepare("DELETE FROM crm_sync_state WHERE key='dieter_cloud_runtime_stop'").run();await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');
 await assert.rejects(scheduleDieterTikTokTransport(f.env,{...f.args,sourceDurationSeconds:15},'repair-one'),/immutable_transport_conflict/);
 assert.equal(f.db.prepare("SELECT status FROM ugc_reel_jobs WHERE content_id='one'").get().status,'queued');
});

test('TikTok transport rechecks stop after cached assignment immediately before publishing',async t=>{
 const f=transportFixture(t),scheduled=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');let sleeps=0;
 const step={async do(name,options,callback){if(name==='tiktok-publish-once')f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_runtime_stop','{}');return (typeof options==='function'?options:callback)();},async sleep(){sleeps++;}};
 const result=await f.workflow.run({payload:{content_id:'one',claim_id:'exact-claim',transport:'tiktok',transport_id:scheduled.transport_id},instanceId:scheduled.workflow_id},step);
 assert.equal(result.tiktok_status,'blocked');assert.equal(result.code,'dieter_tiktok_runtime_incident_stop');assert.equal(sleeps,0);assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'ugc-tiktok-business:%'").get().n,0);
});

test('one pre-assignment execution recovery preserves provider identity and cannot become an unbounded restart loop',async t=>{
 const f=transportFixture(t);const first=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');
 f.env.DIETER_CLOUD.get=async()=>({async status(){return {status:'errored'};}});
 const recovered=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');assert.equal(recovered.workflow_id,first.workflow_id+'-recovery-1');assert.equal(recovered.transport_id,first.transport_id);
 const again=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');assert.equal(again.workflow_id,recovered.workflow_id);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'ugc-tiktok-business:%'").get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'dieter_tiktok_transport:%:prior-execution:%'").get().n,1);
});

test('explicit repaired pre-provider execution can use the last bounded attempt but never replay a provider intent',async t=>{
 const f=transportFixture(t),first=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');
 const key='dieter_tiktok_transport:'+first.transport_id;
 f.env.DIETER_CLOUD.get=async()=>({async status(){return {status:'errored'};}});
 const second=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(key+':execution:'+second.workflow_id+':started',JSON.stringify({workflow_id:second.workflow_id}));
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run(key+':result','{"tiktok_status":"blocked"}');
 f.env.DIETER_CLOUD.get=async()=>({async status(){return {status:'complete'};}});
 assert.equal((await scheduleDieterTikTokTransport(f.env,f.args,'repair-one')).workflow_id,second.workflow_id);
 const third=await scheduleDieterTikTokTransport(f.env,f.args,'repair-one',true);assert.equal(third.workflow_id,first.workflow_id+'-recovery-2');
 assert.equal((await scheduleDieterTikTokTransport(f.env,f.args,'repair-one',true)).workflow_id,third.workflow_id);
 assert.equal(f.db.prepare("SELECT count(*) n FROM crm_sync_state WHERE key LIKE 'ugc-tiktok-business:%'").get().n,0);
});
test('accepted API provider states wait in Workflows instead of launching another model',async t=>{
 const f=transportFixture(t),modes=[];
 f.db.prepare("UPDATE ugc_reel_jobs SET status='working',claim_id='exact-claim',attempts=2 WHERE content_id='one'").run();
 f.db.prepare("DELETE FROM crm_sync_state WHERE key='dieter_cloud_execution_hold:one'").run();
 f.env.DIETER_SUBSCRIPTION.fetch=async(_url,init)=>{modes.push(JSON.parse(init.body).execution.mode);f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('ugc-tiktok-business:one:'+f.args.sourceSha256,'{"state":"accepted","identity":{"claimId":"exact-claim"}}');return Response.json({text:'Known API completion pending'});};
 const proof={platform:'tiktok',url:'https://tiktok.com/@dasbroadcast/video/1234567890',account:'dasbroadcast',verified:true,verified_at:'2026-11-10T05:00:00Z',evidence:'Verified API fixture'};
 const step={...f.step,async sleep(){f.db.prepare("UPDATE ugc_reel_jobs SET status='published',publications=? WHERE content_id='one'").run(JSON.stringify([...f.proofs,proof]));}};
 const result=await f.workflow.run({payload:{content_id:'one',claim_id:'exact-claim'},instanceId:'normal-cloud-flow'},step);
 assert.equal(result.publication_verified,true,JSON.stringify({result,modes}));assert.deepEqual(modes,['work']);
});

test('full-flow timing ends only after all saved publications and separates repair runs',async t=>{
 const f=workflowFixture(t);
 f.db.exec("UPDATE ugc_reel_jobs SET status='published',required_destinations='[\"youtube\"]',started_at='2026-11-10T04:00:00Z',published_at='2026-11-10T04:15:00Z',publications='[{\"platform\":\"youtube\",\"url\":\"https://www.youtube.com/watch?v=actualId123\",\"account\":\"company\",\"verified\":true,\"verified_at\":\"2026-11-10T04:14:59Z\",\"evidence\":\"public video and source checked\"}]' WHERE content_id='one'");
 const row=f.db.prepare("SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id='one'").get();
 assert.equal(dieterFlowTiming({...row,status:'working'}),null);
 assert.equal(dieterFlowTiming({...row,required_destinations:'["youtube","tiktok"]'}),null);
 const normal=dieterFlowTiming(row);assert.equal(normal.elapsed_ms,900000);assert.equal(normal.clean_run,null);
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_work_ordinal:one:3',JSON.stringify({at:'2026-11-10T04:05:00Z',continuation_id:'repair'}));
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_cloud_continuation:repair',JSON.stringify({claim_id:'exact-claim'}));
 const timing=await saveDieterFlowTiming(f.env,'one','exact-claim');assert.equal(timing.elapsed_ms,600000);assert.equal(timing.clean_run,false);assert.equal(timing.benchmark_class,'repair_run');
 f.db.exec("UPDATE ugc_reel_jobs SET published_at='2026-11-10T04:16:00Z'");
 assert.deepEqual(await saveDieterFlowTiming(f.env,'one','exact-claim'),timing);
});

test('owner one-time authorization starts only its queued video outside hours and is consumed',async t=>{
 const f=fixture(t),outside=Date.parse('2026-11-10T13:37:00Z');
 f.db.prepare('INSERT INTO crm_sync_state VALUES(?,?,0)').run('dieter_manual_once:one',JSON.stringify({content_id:'one',state:'ready',expires_at:'2026-11-11T00:00:00Z'}));
 const req=id=>new Request('https://dieter.internal/dispatch',{method:'POST',body:JSON.stringify({now:outside,contentId:id})});
 assert.equal((await (await f.wake.fetch(req('two'))).json()).note,'outside_window');
 const started=await (await f.wake.fetch(req('one'))).json();assert.equal(started.accepted,true);assert.equal(f.created.length,1);
 const saved=JSON.parse(f.db.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_manual_once:one'").get().value);
 assert.equal(saved.state,'consumed');assert.equal(saved.claim_id,f.db.prepare("SELECT claim_id FROM ugc_reel_jobs WHERE content_id='one'").get().claim_id);
});
