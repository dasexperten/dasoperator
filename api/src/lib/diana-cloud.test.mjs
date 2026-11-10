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
 'ig-dm-attachments':`export const imageUrls=s=>JSON.parse(s||'[]').filter(a=>a.image_data||String(a.mime_type||'').startsWith('image/')).map(a=>a.image_data?.url||a.file_url);export const incomingScreenshots=async(env)=>({images:[],unreadable:0,currentUnavailable:env.unavailable===true,omitted:0});`,
 'diana-context.mjs':`export const prepareDianaContext=async({task})=>({system:'Full Diana profile',imagePolicy:{},receipt:{org_sha:'fixture',skills:['ugc-master','personizer']}});`,
 'diana-subscription.mjs':`export const subscriptionInfer=(env,operation)=>async(messages,options)=>{env.inferences.push({operation,messages,options});return {text:JSON.stringify(env.decision),receipt:{transport:'codex-native',auth:'subscription',model:options.model}}};`,
 'diana-subscription-vision.mjs':`export const checkSubscriptionImages=async({task})=>task.startsWith('Inspect original video frames')?globalThis.__videoFixture:({checks:[],status:'yes'});`,
 'diana-video-vision.mjs':`export const checkVideoFrames=async()=>globalThis.__videoFixture;`,
 'diana-video.mjs':`export const currentVideos=messages=>messages.flatMap(m=>JSON.parse(m.attachments_json||'[]').filter(a=>a.video_data||String(a.mime_type||'').startsWith('video/')).map(a=>({url:a.file_url,messageId:m.id})));export const extractCurrentVideoFrames=async(_env,videos)=>[{mediaType:'image/jpeg',data:'ZmFrZQ==',label:'original video frame',sourceMessageId:videos[0].messageId,videoSha256:'fixture-hash'}];`,
 'ig-dm-watch':`export const sendIgDirect=async(env,handle,text,opts)=>env.send(handle,text,opts);`,
 'ugc-payout-source':`export const ingestCreatorPayouts=async(env,target)=>{env.payoutHandoffs??=[];env.payoutHandoffs.push(target);return {registered:1,payout_id:'payout1'}};`,
 'ugc-payout-intake':`export const prepareCreatorPayout=async(env,input)=>{env.partialIntake=input;return {registered:false,missing_fields:['bank','phone','first_name']}};`,
 'ugc-payout-store':`export const executeUgcPayout=async(env,id,check)=>{if(!await check())return {ok:false,code:'source_changed'};env.executedPayout=id;return {ok:true}};export const refreshUgcPayout=async(env,id)=>{env.refreshedPayout=id;return {ok:!env.refreshFail}};`
};
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile,
 plugins:[{name:'dependencies',setup(b){b.onResolve({filter:/^\.\/|^\.\.\//},args=>{const name=args.path.split('/').at(-1);return stubs[name]?{path:name,namespace:'fixture'}:undefined;});b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path]}));}}]});
const cloud=await import(pathToFileURL(outfile));
const dispatchFile=join(dir,'dispatch.mjs');
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-dispatch.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:dispatchFile});
const {dispatchDianaCloud}=await import(pathToFileURL(dispatchFile));
const lockFile=join(dir,'lock.mjs');
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-lock.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:lockFile});
const {reserveDianaCloud,releaseDianaCloud,readDianaCloudLock}=await import(pathToFileURL(lockFile));
rmSync(dir,{recursive:true});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_ig_messages(id TEXT PRIMARY KEY,conversation_id TEXT,direction TEXT,from_id TEXT,from_username TEXT,text TEXT,attachments_json TEXT,created_at TEXT,seen_at TEXT);
 CREATE TABLE ugc_creators(id TEXT PRIMARY KEY,normalized_handle TEXT,lifecycle_stage TEXT,updated_at INTEGER);
 CREATE TABLE ugc_creator_platforms(creator_id TEXT,normalized_handle TEXT,platform TEXT);
 CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,creator_id TEXT,amount_minor INTEGER,status TEXT,product TEXT,paid_at TEXT,failed_at TEXT,sent_at TEXT,created_at INTEGER,konsol_payment_id TEXT,konsol_status TEXT,konsol_error TEXT,notice_status TEXT,notice_message_id TEXT,handle TEXT,notice_at TEXT,notice_error TEXT,paid_notice_at TEXT,updated_at INTEGER,execute_claim TEXT);
 INSERT INTO ugc_creators VALUES('creator-id','creator','replied',1);
 INSERT INTO ugc_creator_platforms VALUES('creator-id','creator','instagram');`);
 const f={db,files:new Map(),sends:[],graphReads:[],originals:[{id:'incoming',from:{id:'person',username:'creator'},message:'Расскажите о программе',created_time:'2026-11-09T09:00:00Z'}]};
 f.event={cid:'chat',message_id:'incoming',event_id:'message:incoming',handle:'creator',at:'2026-11-09T09:00:00.000Z'};
 f.set=(k,v)=>db.prepare('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)').run(k,typeof v==='string'?v:JSON.stringify(v),Date.now());
 f.state=k=>db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(k)?.value;
 f.set('diana_cloud_mode','enabled');f.set('diana_round_alarm:chat',f.event);
 const DB={prepare(sql){let values=[];const st={bind(...v){values=v;return st;},async first(){return db.prepare(sql).get(...values)??null;},async all(){return{results:db.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};return st;},async batch(st){return Promise.all(st.map(s=>s.run()));}};
 f.env={DB,META_IG_MESSAGING_TOKEN:'fixture',GITHUB_TOKEN:'fixture',inferences:[],decision:{reply:'Расскажу)',replies:null,escalate:false,reason:'programme',send_cards:false,send_ozon_photo:false,requisites:null},
 DOCS:{async put(k,v){f.files.set(k,v);},async get(k){return f.files.has(k)?{json:async()=>JSON.parse(f.files.get(k))}:null;},async head(k){return f.files.has(k)?{}:null;}},
 async send(handle,text,opts){f.sends.push({handle,text,opts});const id='out-'+f.sends.length;f.originals.unshift({id,from:{id:'17841466350261166'},message:text,created_time:'2026-11-09T09:01:00Z'});return{ok:true,messageId:id};}};
 t.mock.method(globalThis,'fetch',async url=>{
  const u=new URL(url),id=u.pathname.split('/').at(-1);f.graphReads.push(u.pathname+u.search);
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
test('Diana hands complete requisites to payout for the exact incoming message',async t=>{
 const f=fixture(t);
 f.env.decision={...f.env.decision,reply:null,requisites:{amount_rub:453,phone:'89990000000',bank:'ТБанк',first_name:'Елена'}};
 const {draft}=await f.prepare();
 assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'registered');
 assert.deepEqual(f.env.payoutHandoffs,[{conversation_id:'chat',message_id:'incoming',phone:'+79990000000',bank:'100000000004',first_name:'Елена',amount_minor:45300,image:false,originals:[{id:'incoming',direction:'in',text:'Расскажите о программе'}]}]);
 assert.equal((await cloud.executeCloudPayout(f.env,'payout1',f.event,'person')).status,'submitted_or_already_exists');assert.equal(f.env.executedPayout,'payout1');
 assert.equal(f.env.refreshedPayout,'payout1');
 f.env.executedPayout=undefined;f.originals[0].from.id='another-person';
 await assert.rejects(cloud.executeCloudPayout(f.env,'payout1',f.event,'person'),/source_changed/);assert.equal(f.env.executedPayout,undefined);
});
test('a provider read outage after submission stays visible without resending',async t=>{
 const f=fixture(t);f.env.refreshFail=true;
 const result=await cloud.executeCloudPayout(f.env,'payout1',f.event,'person');
 assert.equal(result.provider_checked,false);assert.equal(f.env.executedPayout,'payout1');
 assert.equal(JSON.parse(f.state('diana_payout_refresh_pending:payout1')).reason,'provider_read_unavailable');
});
test('partial payment details create a durable signal without a transfer',async t=>{
 const f=fixture(t);f.originals[0].message='Телефон 89990000000';
 f.env.decision={...f.env.decision,reply:'Уточните банк, пожалуйста.',requisites:null,payout_requisites_detected:true};
 const {draft}=await f.prepare();
 assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'partial');
 const signal=JSON.parse(f.state('diana_payout_signal:message:incoming'));
 assert.equal(signal.status,'incomplete');assert.equal(signal.message_id,'incoming');
 assert.equal(f.env.partialIntake.cycle_message_id,'incoming');
 assert.equal(f.env.payoutHandoffs,undefined);assert.equal(f.env.executedPayout,undefined);
});
test('preview exercises the same chain with zero sends and no live ACK',async t=>{
 const f=fixture(t);f.set('diana_cloud_mode','disabled');const event={...f.event,dryRun:true};
 const {draft}=await f.prepare(event),outcome=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(outcome.status,'preview');
 await cloud.completeCloudEvent(f.env,event,outcome);assert.equal(f.sends.length,0);assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.state('diana_message_done:chat'),undefined);assert.equal(f.state('diana_cloud_event:'+event.event_id),undefined);
});
test('a newer incoming message while Diana thinks prevents every send',async t=>{
 const f=fixture(t),{draft}=await f.prepare();f.originals.unshift({id:'new',from:{id:'person',username:'creator'},message:'Передумала',created_time:'2026-11-09T09:02:00Z'});
 const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'needs_review');assert.equal(f.sends.length,0);assert.ok(f.state('diana_round_alarm:chat'));
});
test('ambiguous Meta outcome stays open and is never automatically sent again',async t=>{
 const f=fixture(t),{draft}=await f.prepare();f.env.send=async()=>{f.sends.push({});return{ok:false,delivery:'unknown',error:'timeout'};};
 const a=await cloud.deliverCloudDecision(f.env,draft.key);await cloud.completeCloudEvent(f.env,f.event,a);await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(f.sends.length,1);assert.equal(f.state('diana_message_done:chat'),undefined);assert.ok(f.state('diana_round_alarm:chat'));
});
test('cutoff defers without acknowledging and next day resumes only the unsent part',async t=>{
 const f=fixture(t);f.env.decision.reply='Первое';f.env.decision.replies=['Первое','Второе'];
 const {draft}=await f.prepare();const before=Date.parse('2026-11-10T23:29:59+03:00'),after=Date.parse('2026-11-10T23:30:00+03:00');let n=0;
 const first=await cloud.deliverCloudDecision(f.env,draft.key,()=>++n<=2?before:after);
 assert.equal(first.status,'deferred');assert.equal(f.sends.length,1);await cloud.completeCloudEvent(f.env,f.event,first);
 assert.ok(f.state('diana_round_alarm:chat'));assert.equal(JSON.parse(f.state('diana_cloud_event:'+f.event.event_id)).status,'deferred');
 const resumed=await f.prepare();const final=await cloud.deliverCloudDecision(f.env,resumed.draft.key,()=>Date.parse('2026-11-11T08:00:00+03:00'));
 assert.equal(final.status,'delivered');assert.equal(f.sends.length,2);await cloud.completeCloudEvent(f.env,f.event,final);
 assert.equal(f.state('diana_round_alarm:chat'),undefined);
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
test('scheduled review can read a conversation whose last message is ours without acknowledging a Direct alarm',async t=>{
 const f=fixture(t);f.originals.unshift({id:'previous-out',from:{id:'17841466350261166'},message:'Проверяем',created_time:'2026-11-09T09:00:05Z'});
 const event={...f.event,event_id:'round:2026-11-10:morning:creator-id',task:'round',round_slot:'2026-11-10:morning',creator_id:'creator-id'};
 f.env.decision.reply=null;f.env.decision.reason='No new action.';
 const {draft}=await f.prepare(event),outcome=await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(outcome.status,'no_reply');await cloud.completeCloudEvent(f.env,event,outcome);
 assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.state('diana_message_done:chat'),undefined);assert.equal(f.sends.length,0);
});
test('exact Owner choice is delivered once and only marked answered after original readback',async t=>{
 const f=fixture(t),q={cid:'chat',handle:'creator',at:f.event.at,options:{'Ответить':['Хорошо']},choice:'Ответить',decision_at:'2026-11-10T00:00:00Z'};
 f.set('ig_hard:42',q);const event={...f.event,event_id:'action:choice42',task:'owner_choice',question_id:'42'};
 f.set('diana_action_pending:'+event.event_id,event);f.env.decision.reply='Хорошо';
 const {draft}=await f.prepare(event),out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'delivered');assert.equal(JSON.parse(f.state('ig_hard:42')).answered_at,undefined);
 await cloud.completeCloudEvent(f.env,event,out);assert.ok(JSON.parse(f.state('ig_hard:42')).answered_at);assert.equal(f.sends.length,1);
});
test('dispatcher creates exactly one durable event, waits on its real status and preserves paused actions',async t=>{
 const f=fixture(t),instances=new Map(),creates=[];
 f.env.DIANA_CLOUD={async create({id,params}){creates.push({id,params});instances.set(id,'running');},async get(id){return{async status(){if(!instances.has(id))throw Error('not found');return{status:instances.get(id)};}};}};
 f.set('diana_action_pending:action:reminder',{...f.event,event_id:'action:reminder',task:'video_reminder'});
 assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse("2026-11-10T12:00:00+03:00"))).dispatched,true);assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse("2026-11-10T12:00:00+03:00"))).reason,'diana_cloud_working');assert.equal(creates.length,1);
 assert.ok(f.state('diana_action_pending:action:reminder'));
 instances.set(creates[0].id,'complete');f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review'});
 assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse("2026-11-10T12:00:00+03:00"))).reason,'cloud_events_await_review');assert.equal(creates.length,1);
});
test('a terminal instance without a verified event receipt is not reported as dispatched or replayed',async t=>{
 const f=fixture(t),instances=new Map(),created=[];
 f.env.DIANA_CLOUD={async create(x){created.push(x);instances.set(x.id,'running')},async get(id){return{async status(){return{status:instances.get(id)}}}}};
 const now=Date.parse('2026-11-11T08:00:00+03:00');await dispatchDianaCloud(f.env,undefined,now);instances.set(created[0].id,'terminated');
 const result=await dispatchDianaCloud(f.env,undefined,now+1000);assert.equal(result.dispatched,false);assert.equal(created.length,1);
 assert.equal(JSON.parse(f.state('diana_cloud_event:'+f.event.event_id)).reason,'terminal_workflow_without_verified_receipt');
 assert.ok(f.state('diana_round_alarm:chat'));
});
test('outside Moscow Direct hours the event remains queued and no workflow starts',async t=>{
 const f=fixture(t),creates=[];
 f.env.DIANA_CLOUD={async create(v){creates.push(v)}};
 for(const at of ['2026-11-10T07:59:59+03:00','2026-11-10T23:30:00+03:00','2026-11-11T06:00:00+03:00']) {
   assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse(at))).reason,'outside_direct_hours');
 }
 assert.equal(creates.length,0);
 assert.ok(f.state('diana_round_alarm:chat'));
});
test('deferred event starts with a fresh stable workflow identity at 08:00, never at 07:59',async t=>{
 const f=fixture(t),instances=new Map(),created=[];f.set('diana_cloud_event:'+f.event.event_id,{status:'deferred'});
 f.env.DIANA_CLOUD={async create(x){created.push(x);instances.set(x.id,'running')},async get(id){return{async status(){if(!instances.has(id))throw Error('not found');return {status:instances.get(id)}}}}};
 assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T07:59:59+03:00'))).reason,'outside_direct_hours');
 assert.equal(created.length,0);assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'))).dispatched,true);
 assert.equal(created.length,1);assert.equal(created[0].params.event_id,f.event.event_id);
 assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:01+03:00'))).reason,'diana_cloud_working');assert.equal(created.length,1);
});
test('direct and round share an atomic owner lock; another owner cannot release it',async t=>{
 const f=fixture(t), round={kind:'round',id:'round-2026-11-10-night'}, direct={kind:'direct',id:'direct-other'};
 assert.equal(await reserveDianaCloud(f.env,round),true);
 assert.equal(await reserveDianaCloud(f.env,direct),false);
 assert.deepEqual(await readDianaCloudLock(f.env),round);
 assert.equal(await releaseDianaCloud(f.env,direct),false);
 f.env.DIANA_CLOUD={async create(){assert.fail('round is active');}};
 assert.equal((await dispatchDianaCloud(f.env,undefined,Date.parse("2026-11-10T12:00:00+03:00"))).reason,'diana_cloud_locked');
 assert.deepEqual(await readDianaCloudLock(f.env),round);
 assert.equal(await releaseDianaCloud(f.env,round),true);
 assert.equal(await reserveDianaCloud(f.env,direct),true);
});
test('confirmed paid action can notify after our last reply, with a separate outbox and verified payout receipt',async t=>{
 const f=fixture(t);
 f.db.prepare(`INSERT INTO ugc_payouts(id,creator_id,handle,amount_minor,status,paid_at,konsol_payment_id,konsol_status,notice_status,created_at,updated_at) VALUES('p1','creator-id','creator',45300,'paid','2026-11-09T08:59:00Z','payment1','executed','queued',1,1)`).run();
 f.originals.unshift({id:'previous-out',from:{id:'17841466350261166'},message:'Проверяем',created_time:'2026-11-09T09:00:05Z'});
 const event={...f.event,event_id:'action:paid',task:'payout_paid_notice',payout_id:'p1'};f.set('diana_action_pending:'+event.event_id,event);
 f.env.decision.reply='Перевели 453 ₽ по СБП. Проверьте, пожалуйста.';
 const {draft}=await f.prepare(event),out=await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(out.status,'delivered');assert.match(out.deliveryKey,/:action:action:paid$/);
 await cloud.completeCloudEvent(f.env,event,out);
 const row=f.db.prepare("SELECT status,notice_status,notice_message_id,konsol_payment_id FROM ugc_payouts WHERE id='p1'").get();
 assert.equal(row.status,'paid');assert.equal(row.konsol_payment_id,'payment1');assert.equal(row.notice_status,'delivered');assert.equal(row.notice_message_id,'out-1');
 assert.equal(f.state('diana_action_pending:action:paid'),undefined);assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.sends.length,1);
 await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);
});
test('failed payout notice keeps the provider outcome and saves only actual message delivery',async t=>{
 const f=fixture(t);f.db.prepare(`INSERT INTO ugc_payouts(id,creator_id,handle,amount_minor,status,failed_at,konsol_payment_id,konsol_status,notice_status,created_at,updated_at) VALUES('p2','creator-id','creator',45300,'failed','2026-11-09T08:59:00Z','payment2','failed','queued',1,1)`).run();
 const event={...f.event,event_id:'action:failed',task:'payout_failed_notice',payout_id:'p2'};f.set('diana_action_pending:'+event.event_id,event);
 const {draft}=await f.prepare(event),out=await cloud.deliverCloudDecision(f.env,draft.key);await cloud.completeCloudEvent(f.env,event,out);
 const row=f.db.prepare("SELECT status,notice_status,notice_message_id FROM ugc_payouts WHERE id='p2'").get();assert.equal(row.status,'failed');assert.equal(row.notice_status,'delivered');assert.equal(row.notice_message_id,'out-1');
});
test('an unconfirmed payment cannot become a paid notice even if the queue says paid',async t=>{
 const f=fixture(t);f.db.prepare(`INSERT INTO ugc_payouts(id,creator_id,handle,amount_minor,status,konsol_payment_id,konsol_status,created_at,updated_at) VALUES('p1','creator-id','creator',45300,'sent','payment1','processing',1,1)`).run();
 await assert.rejects(cloud.readCloudConversation(f.env,{...f.event,event_id:'action:bad',task:'payout_paid_notice',payout_id:'p1'}),/outcome_not_confirmed/);assert.equal(f.sends.length,0);
});
test('dispatcher prioritizes confirmed financial actions without restarting proactive reminders',async t=>{
 const f=fixture(t),created=[];f.env.DIANA_CLOUD={async create(p){created.push(p);},async get(){return{async status(){return{status:'complete'};}};}};
 f.set('diana_action_pending:action:paid',{...f.event,event_id:'action:paid',task:'payout_paid_notice',payout_id:'p1'});
 await dispatchDianaCloud(f.env,undefined,Date.parse("2026-11-10T12:00:00+03:00"));assert.equal(created[0].params.task,'payout_paid_notice');assert.equal(created[0].params.payout_id,'p1');assert.ok(f.state('diana_round_alarm:chat'));
});

test('an already delivered payout notice cannot be repeated by a new model decision',async t=>{
 const f=fixture(t);f.originals.unshift({id:'notice-original',from:{id:'17841466350261166'},message:'Перевели',created_time:'2026-11-09T09:00:05Z'});
 f.db.prepare(`INSERT INTO ugc_payouts(id,creator_id,handle,status,paid_at,konsol_payment_id,konsol_status,notice_status,notice_message_id,created_at,updated_at) VALUES('p1','creator-id','creator','paid','2026-11-09T08:59:00Z','payment1','executed','delivered','notice-original',1,1)`).run();
 const event={...f.event,event_id:'action:already-paid',task:'payout_paid_notice',payout_id:'p1'};f.set('diana_action_pending:'+event.event_id,event);
 const {draft}=await f.prepare(event),out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'no_reply');assert.equal(f.sends.length,0);
 await cloud.completeCloudEvent(f.env,event,out);assert.equal(f.db.prepare("SELECT notice_message_id FROM ugc_payouts WHERE id='p1'").get().notice_message_id,'notice-original');assert.equal(f.state('diana_action_pending:'+event.event_id),undefined);
});
test('a no-reply decision cannot close a payment action after its provider facts change',async t=>{
 const f=fixture(t);f.db.prepare(`INSERT INTO ugc_payouts(id,creator_id,handle,status,paid_at,konsol_payment_id,konsol_status,notice_status,created_at,updated_at) VALUES('p1','creator-id','creator','paid','2026-11-09T08:59:00Z','payment1','executed','queued',1,1)`).run();
 const event={...f.event,event_id:'action:changed-payment',task:'payout_paid_notice',payout_id:'p1'};f.env.decision.reply=null;
 const {draft}=await f.prepare(event);f.db.prepare("UPDATE ugc_payouts SET konsol_payment_id='replacement' WHERE id='p1'").run();
 const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'needs_review');assert.equal(f.sends.length,0);
});


test('confirmed product gets only a short thank-you and keeps separate video review',async t=>{
 const f=fixture(t);f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};
 globalThis.__videoFixture={checks:[{product:'yes',observed:{product_name:'TERMO'},requisites:{},unresolved_required:[]}]};
 f.env.decision={...f.env.decision,reply:'Качество отличное, публикуйте!',send_cards:true};
 const {draft}=await f.prepare();const result=await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(result.status,'delivered');assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Спасибо за видео!');
 const review=JSON.parse(f.state('diana_video_pending:'+f.event.event_id));assert.equal(review.reason,'video_payment_coverage_unverified');assert.equal(review.message_id,'incoming');
 await cloud.completeCloudEvent(f.env,f.event,result);assert.ok(f.state('diana_video_pending:'+f.event.event_id));
});
test('video with unresolved requisites or no visible product stays in review with source evidence',async t=>{
 for(const result of [
  {checks:[{product:'yes',observed:{product_name:'TERMO'},requisites:{phone:'partial'},unresolved_required:['phone']}]},
  {checks:[{product:'unknown',observed:{product_name:null},requisites:{},unresolved_required:[]}]},
 ]){
  const f=fixture(t);f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};globalThis.__videoFixture=result;
  const source=await cloud.readCloudConversation(f.env,f.event);const ctx=await cloud.prepareCloudDecision(f.env,source.key);
  assert.equal(ctx.status,'needs_review');assert.ok(ctx.evidenceKey);assert.equal(f.sends.length,0);assert.equal(f.env.payoutHandoffs,undefined);
  if(result.checks[0].requisites.phone){assert.ok(f.graphReads.some(path=>path.includes('/incoming?fields=id,from,attachments')));assert.equal(ctx.videoSourceVerified,false);assert.ok(f.state('diana_payout_signal:'+f.event.event_id));}

 }
});


test('independently matched video requisites hand off only the original event without sending or paying in test',async t=>{
 const f=fixture(t);f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};
 globalThis.__videoFixture={checks:[{product:'yes',observed:{product_name:'TERMO'},requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:null,currency:null,card:null},unresolved_required:[]}]};
 const {draft}=await f.prepare();const handoff=await cloud.handoffCloudPayout(f.env,draft.key);
 assert.equal(handoff.status,'registered');assert.equal(f.env.payoutHandoffs[0].video,true);assert.equal(f.env.payoutHandoffs[0].message_id,'incoming');
 assert.equal(f.sends.length,0);assert.equal(f.env.executedPayout,undefined);
});

test('screenshot requisites trigger original-image verification without sending or paying in the test',async t=>{
 const f=fixture(t);f.originals[0].message='';f.originals[0].attachments={data:[{mime_type:'image/jpeg',image_data:{url:'https://x.fbcdn.net/image'}}]};
 f.env.decision={...f.env.decision,requisites:{phone:'89990000000',bank:'ТБанк',first_name:'Елена',amount_rub:453}};
 const {draft}=await f.prepare();const result=await cloud.handoffCloudPayout(f.env,draft.key);
 assert.equal(result.status,'registered');assert.equal(f.env.payoutHandoffs[0].image,true);assert.equal(f.env.payoutHandoffs[0].originals[0].text,'');assert.equal(f.sends.length,0);assert.equal(f.env.executedPayout,undefined);
});

test('one video-only recovery uses distinct durable identity without rewriting prior receipt',async t=>{
 const f=fixture(t),instances=new Map(),created=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};const old={status:'needs_review',reason:'Алена прислала ролик, требуется проверить'};
 f.set('diana_cloud_event:'+f.event.event_id,old);
 f.env.DIANA_CLOUD={async create(x){created.push(x);instances.set(x.id,'running')},async get(id){return{async status(){return{status:instances.get(id)}}}}};
 const now=Date.parse('2026-11-11T08:00:00+03:00');const first=await dispatchDianaCloud(f.env,undefined,now);
 assert.equal(first.dispatched,true);assert.equal(created.length,1);assert.equal(created[0].params.recovery,true);
 assert.deepEqual(JSON.parse(f.state('diana_cloud_event:'+f.event.event_id)),old);
 assert.equal(JSON.parse(f.state('diana_video_recovery_result:'+f.event.event_id)).status,'queued');
 await releaseDianaCloud(f.env,{kind:'direct',id:created[0].id});f.set('diana_cloud_finished:'+created[0].id,{kind:'direct',id:created[0].id});
 await dispatchDianaCloud(f.env,undefined,now+1000);assert.equal(created.length,1);
});
test('recovery completion never acknowledges or changes original delivery receipts',async t=>{
 const f=fixture(t),event={...f.event,recovery:true};const original={status:'needs_review',reason:'video_original_missing'};
 f.set('diana_cloud_event:'+event.event_id,original);const result=await cloud.completeCloudEvent(f.env,event,{status:'needs_review',reason:'video_recovery_no_payment_or_delivery'});
 assert.equal(result.status,'needs_review');assert.deepEqual(JSON.parse(f.state('diana_cloud_event:'+event.event_id)),original);
 assert.ok(f.state('diana_round_alarm:chat'));assert.equal(f.state('diana_message_done:chat'),undefined);assert.equal(f.sends.length,0);
 assert.notEqual(await cloud.artifactPrefix(event),await cloud.artifactPrefix(f.event));
});
test('recovery never sends even if delivery is accidentally invoked',async t=>{
 const f=fixture(t),event={...f.event,recovery:true};const {draft}=await f.prepare(event);
 assert.equal((await cloud.deliverCloudDecision(f.env,draft.key)).reason,'video_recovery_delivery_disabled');assert.equal(f.sends.length,0);
});
test('recovery stops if existing delivery for that original was sent or uncertain',async t=>{
 for(const status of ['sent','sending']){
  const f=fixture(t),event={...f.event,recovery:true};f.set('ig_reply_delivery:test',{conversationId:'chat',incomingAt:event.at,status:'pending',items:[{status}]});
  const result=await cloud.readCloudConversation(f.env,event);assert.equal(result.reason,'video_recovery_previous_delivery_exists_or_unknown');assert.equal(f.sends.length,0);
 }
});

test('deferred video recovery resumes only next Moscow day with one new durable identity',async t=>{
 const f=fixture(t),instances=new Map(),created=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть ролик'});
 const day=Date.parse('2026-11-10T23:29:00+03:00');f.set('diana_video_recovery_result:'+f.event.event_id,{status:'deferred',at:day});
 f.env.DIANA_CLOUD={async create(x){created.push(x);instances.set(x.id,'running')},async get(id){return{async status(){return{status:instances.get(id)}}}}};
 assert.equal((await dispatchDianaCloud(f.env,undefined,day)).dispatched,false);
 const next=Date.parse('2026-11-11T08:00:00+03:00');assert.equal((await dispatchDianaCloud(f.env,undefined,next)).dispatched,true);assert.equal(created.length,1);assert.equal(created[0].params.recovery,true);
 await releaseDianaCloud(f.env,{kind:'direct',id:created[0].id});f.set('diana_cloud_finished:'+created[0].id,{kind:'direct',id:created[0].id});
 await dispatchDianaCloud(f.env,undefined,next+1000);assert.equal(created.length,1);
});

test('free-text needs_review is not replayed when original is missing, replaced, outgoing, or not video',async t=>{
 for(const mode of ['replaced','outgoing','not-video','token-missing']){
  const f=fixture(t),created=[];f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'произвольная причина'});
  f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};
  if(mode==='replaced')f.originals[0].id='newer';
  if(mode==='outgoing')f.originals[0].from.id='17841466350261166';
  if(mode==='not-video')f.originals[0].attachments={data:[{image_data:{url:'https://x.fbcdn.net/i'}}]};
  if(mode==='token-missing')f.env.META_IG_MESSAGING_TOKEN='';
  f.env.DIANA_CLOUD={async create(x){created.push(x)}};
  const result=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'));
  assert.equal(result.dispatched,false);assert.equal(created.length,0);assert.equal(f.state('diana_video_recovery_result:'+f.event.event_id),undefined);
 }
});
