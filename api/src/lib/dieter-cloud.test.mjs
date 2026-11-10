import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild'),dir=mkdtempSync(join(tmpdir(),'dieter-cloud-')),file=join(dir,'cloud.mjs');
await build({entryPoints:[fileURLToPath(new URL('../dieter-cloud.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:file,plugins:[{name:'runtime',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'runtime',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export class WorkflowEntrypoint{}'}));}}]});
const {DieterWake}=await import(pathToFileURL(file));rmSync(dir,{recursive:true});
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
