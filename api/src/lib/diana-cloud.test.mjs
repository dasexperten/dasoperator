import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {build}=createRequire(import.meta.url)('esbuild');
const dir=mkdtempSync(join(tmpdir(),'diana-cloud-test-'));
const outfile=join(dir,'cloud.mjs');
const stubs={
 'ig-dm-attachments':`export const incomingScreenshots=async(env)=>({images:[],unreadable:0,currentUnavailable:env.unavailable===true,omitted:0});`,
 'diana-context.mjs':`export const prepareDianaContext=async({task})=>({system:'Full Diana profile',imagePolicy:{},receipt:{org_sha:'fixture',skills:['ugc-master','personizer']}});`,
 'diana-subscription.mjs':`export const subscriptionInfer=(env,operation)=>async(messages,options)=>{env.inferences.push({operation,messages,options});return {text:JSON.stringify(env.decision),receipt:{transport:'codex-native',auth:'subscription',model:options.model}}};`,
 'diana-subscription-vision.mjs':`export const checkSubscriptionImages=async()=>({checks:[],status:'yes'});`,
 'ig-dm-watch':`export const sendIgDirect=async(env,handle,text,opts)=>env.send(handle,text,opts);`
};
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile,
 plugins:[{name:'dependencies',setup(b){b.onResolve({filter:/^\.\/|^\.\.\//},args=>{const name=args.path.split('/').at(-1);return stubs[name]?{path:name,namespace:'fixture'}:undefined;});b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path]}));}}]});
const cloud=await import(pathToFileURL(outfile));
const dispatchFile=join(dir,'dispatch.mjs');
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-dispatch.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:dispatchFile});
const {dispatchDianaCloud}=await import(pathToFileURL(dispatchFile));
rmSync(dir,{recursive:true});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_ig_messages(id TEXT PRIMARY KEY,conversation_id TEXT,direction TEXT,from_id TEXT,from_username TEXT,text TEXT,attachments_json TEXT,created_at TEXT,seen_at TEXT);
 CREATE TABLE ugc_creators(id TEXT PRIMARY KEY,normalized_handle TEXT,lifecycle_stage TEXT,updated_at INTEGER);
 CREATE TABLE ugc_creator_platforms(creator_id TEXT,normalized_handle TEXT,platform TEXT);
 CREATE TABLE ugc_payouts(id TEXT,creator_id TEXT,amount_minor INTEGER,status TEXT,product TEXT,paid_at TEXT,sent_at TEXT,created_at INTEGER,konsol_payment_id TEXT);
 INSERT INTO ugc_creators VALUES('creator-id','creator','replied',1);
 INSERT INTO ugc_creator_platforms VALUES('creator-id','creator','instagram');`);
 const f={db,files:new Map(),sends:[],originals:[{id:'incoming',from:{id:'person',username:'creator'},message:'Расскажите о программе',created_time:'2026-11-10T09:00:00Z'}]};
 f.event={cid:'chat',message_id:'incoming',event_id:'message:incoming',handle:'creator',at:'2026-11-10T09:00:00.000Z'};
 f.set=(k,v)=>db.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)').run(k,typeof v==='string'?v:JSON.stringify(v),Date.now());
 f.state=k=>db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(k)?.value;
 f.set('diana_cloud_mode','enabled');f.set('diana_round_alarm:chat',f.event);
 const DB={prepare(sql){let values=[];const st={bind(...v){values=v;return st;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return{results:db.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return st;},async batch(st){return Promise.all(st.map(s=>s.run()));}};
 f.env={DB,META_IG_MESSAGING_TOKEN:'fixture',GITHUB_TOKEN:'fixture',inferences:[],decision:{reply:'Расскажу)',replies:null,escalate:false,reason:'programme',send_cards:false,send_ozon_photo:false,requisites:null},
 DOCS:{async put(k,v){f.files.set(k,v);},async get(k){return f.files.has(k)?{json:async()=>JSON.parse(f.files.get(k))}:null;},async head(k){return f.files.has(k)?{}:null;}},
 async send(handle,text,opts){f.sends.push({handle,text,opts});const id='out-'+f.sends.length;f.originals.unshift({id,from:{id:'17841466350261166'},message:text,created_time:'2026-11-10T09:01:00Z'});return{ok:true,messageId:id};}};
 t.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url),id=u.pathname.split('/').at(-1);
  if(u.searchParams.get('fields')==='access_token')return Response.json({access_token:'fixture-page'});
  if(u.pathname.endsWith('/messages'))return Response.json({data:f.originals});
  if(id==='chat')return Response.json({messages:{data:f.originals.slice(0,1)}});
  const original=f.originals.find(m=>m.id===id);
  return original?Response.json(original):new Response('',{status:404});
 });
 f.prepare=async(event=f.event)=>{const source=await cloud.readCloudConversation(f.env,event);const context=await cloud.prepareCloudDecision(f.env,source.key);const draft=await cloud.draftCloudDecision(f.env,context.key);return {source,context,draft};};
 return f;
}
test('original -> full context -> Terra -> Meta -> verified ERP ACK; retry never sends twice',async t=>{
 const f=fixture(t),{draft}=await f.prepare();
 assert.equal(f.env.inferences[0].operation,'reply');assert.equal(f.env.inferences[0].options.model,'gpt-6.1-terra');assert.match(f.env.inferences[0].messages[0].content,/Full Diana profile/);
 const delivered=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(delivered.status,'delivered');assert.equal(f.sends.length,1);assert.equal(f.sends[0].opts.humanAgent,undefined);
 const complete=await cloud.completeCloudEvent(f.env,f.event,delivered);assert.equal(complete.status,'complete');assert.equal(f.state('diana_message_done:chat'),'incoming');assert.equal(f.state('diana_round_alarm:chat'),undefined);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ugc_ig_messages WHERE direction='out'").get().n,1);
 await cloud.deliverCloudDecision(f.env,draft.key);await cloud.completeCloudEvent(f.env,f.event,delivered);assert.equal(f.sends.length,1);
});
test('preview exercises the same chain with zero sends and no live ACK',async t=>{
 const f=fixture(t);f.set('diana_cloud_mode','disabled');const event={...f.event,dryRun:true};
 const {draft}=await f.prepare(event),outcome=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(outcome.status,'preview');
 await cloud.completeCloudEvent(f.env,event,outcome);assert.equal(f.sends.length,0);assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.state('diana_message_done:chat'),undefined);assert.equal(f.state('diana_cloud_event:'+event.event_id),undefined);
});
test('a newer incoming message while Diana thinks prevents every send',async t=>{
 const f=fixture(t),{draft}=await f.prepare();f.originals.unshift({id:'new',from:{id:'person',username:'creator'},message:'Передумала',created_time:'2026-11-10T09:02:00Z'});
 const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'needs_review');assert.equal(f.sends.length,0);assert.ok(f.state('diana_round_alarm:chat'));
});
test('ambiguous Meta outcome stays open and is never automatically sent again',async t=>{
 const f=fixture(t),{draft}=await f.prepare();f.env.send=async()=>{f.sends.push({});return{ok:false,delivery:'unknown',error:'timeout'};};
 const a=await cloud.deliverCloudDecision(f.env,draft.key);await cloud.completeCloudEvent(f.env,f.event,a);await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(f.sends.length,1);assert.equal(f.state('diana_message_done:chat'),undefined);assert.ok(f.state('diana_round_alarm:chat'));
});
test('unsupported or unreadable current attachment cannot produce an invented answer',async t=>{
 const f=fixture(t);f.originals[0].is_unsupported=true;let source=await cloud.readCloudConversation(f.env,f.event);
 assert.equal((await cloud.prepareCloudDecision(f.env,source.key)).status,'needs_review');assert.equal(f.env.inferences.length,0);
 delete f.originals[0].is_unsupported;f.env.unavailable=true;source=await cloud.readCloudConversation(f.env,f.event);
 await assert.rejects(cloud.prepareCloudDecision(f.env,source.key),/current_image_unavailable/);assert.equal(f.sends.length,0);
});
test('rollback/pause and an active M1 claim prevent cloud execution',async t=>{
 const f=fixture(t);f.set('diana_cloud_mode','disabled');await assert.rejects(cloud.readCloudConversation(f.env,f.event),/cloud_paused/);
 f.set('diana_cloud_mode','enabled');f.set('diana_round_claim','primary:running');await assert.rejects(cloud.readCloudConversation(f.env,f.event),/machine_still_working/);assert.equal(f.sends.length,0);
});
test('failed original-message readback does not acknowledge delivery',async t=>{
 const f=fixture(t),{draft}=await f.prepare(),out=await cloud.deliverCloudDecision(f.env,draft.key);f.originals=[];
 await assert.rejects(cloud.completeCloudEvent(f.env,f.event,out),/meta_read_http_404/);assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.state('diana_message_done:chat'),undefined);
});
test('old completion cannot remove a newer incoming alarm',async t=>{
 const f=fixture(t),{draft}=await f.prepare(),out=await cloud.deliverCloudDecision(f.env,draft.key);
 f.set('diana_round_alarm:chat',{...f.event,message_id:'new',event_id:'message:new'});await cloud.completeCloudEvent(f.env,f.event,out);
 assert.equal(JSON.parse(f.state('diana_round_alarm:chat')).message_id,'new');assert.equal(f.state('diana_message_done:chat'),undefined);
});
test('dispatcher creates exactly one durable event, waits on its real status and preserves paused actions',async t=>{
 const f=fixture(t),instances=new Map(),creates=[];
 f.env.DIANA_CLOUD={async create({id,params}){creates.push({id,params});instances.set(id,'running');},async get(id){return{async status(){if(!instances.has(id))throw Error('not found');return{status:instances.get(id)};}};}};
 f.set('diana_action_pending:action:reminder',{...f.event,event_id:'action:reminder',task:'video_reminder'});
 assert.equal((await dispatchDianaCloud(f.env)).dispatched,true);assert.equal((await dispatchDianaCloud(f.env)).reason,'diana_cloud_working');assert.equal(creates.length,1);
 assert.ok(f.state('diana_action_pending:action:reminder'));
 instances.set(creates[0].id,'complete');f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review'});
 assert.equal((await dispatchDianaCloud(f.env)).reason,'cloud_events_await_review');assert.equal(creates.length,1);
});
