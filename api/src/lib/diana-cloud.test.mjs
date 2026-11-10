import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
// Make delivery tests independent of the hour at which CI runs.
mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-10T09:00:00Z')});
const {build}=createRequire(import.meta.url)('esbuild');
const dir=mkdtempSync(join(tmpdir(),'diana-cloud-test-'));
const outfile=join(dir,'cloud.mjs');
const stubs={
 'ig-dm-attachments':`export const imageUrls=s=>JSON.parse(s||'[]').filter(a=>a.image_data||String(a.mime_type||'').startsWith('image/')).map(a=>a.image_data?.url||a.file_url);export const incomingScreenshots=async(env)=>env.screenshots??({images:[],unreadable:0,currentUnavailable:env.unavailable===true,omitted:0});`,
 'diana-context.mjs':`export const prepareDianaContext=async({task})=>({system:'Full Diana profile. Verified fixture terms: order the product; reimbursement follows receipt confirmation.',imagePolicy:{sellers:[{legal_name:'ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ'}]},receipt:{org_sha:'fixture',skills:['ugc-master','personizer']}});`,
 'diana-subscription.mjs':`export const subscriptionInfer=(env,operation)=>async(messages,options)=>{env.inferences.push({operation,messages,options});return {text:JSON.stringify(env.decisions?.shift()??env.decision),receipt:{transport:'codex-native',auth:'subscription',model:options.model}}};`,
 'diana-subscription-vision.mjs':`export const checkSubscriptionImages=async({task})=>task.startsWith('Inspect original video frames')?globalThis.__videoFixture:(globalThis.__imageFixture?structuredClone(globalThis.__imageFixture):({checks:[],status:'yes'}));`,
 'diana-video-vision.mjs':`export const checkVideoFrames=async()=>globalThis.__videoFixture;`,
 'diana-video.mjs':`export const currentVideos=messages=>messages.flatMap(m=>JSON.parse(m.attachments_json||'[]').filter(a=>a.video_data||String(a.mime_type||'').startsWith('video/')).map(a=>({url:a.file_url,messageId:m.id})));export const extractCurrentVideoFrames=async(_env,videos)=>{_env.videoReads=(_env.videoReads??0)+1;if(_env.failVideoRecheck&&_env.videoReads%2===0)throw Error('sensitive fixture');return [{mediaType:'image/jpeg',data:'ZmFrZQ==',label:'original video frame',sourceMessageId:videos[0].messageId,videoSha256:'fixture-hash'}]};`,
 'ig-dm-watch':`export const IG_UNSUPPORTED='unsupported';export const refreshIgAttachments=async(env,id)=>env.restored?.[id]??null;export const sendIgDirect=async(env,handle,text,opts)=>env.send(handle,text,opts);`,
 'ugc-payout-source':`export const ingestCreatorPayouts=async(env,target)=>{env.payoutHandoffs??=[];env.payoutHandoffs.push(target);return {registered:1,payout_id:'payout1'}};`,
 'ugc-payout-intake':`export const prepareCreatorPayout=async(env,input)=>{env.partialIntake=input;return {registered:false,missing_fields:['bank','phone','first_name']}};`,
 'ugc-payout-store':`export const executeUgcPayout=async(env,id,check)=>{if(!await check())return {ok:false,code:'source_changed'};env.executedPayout=id;return {ok:true}};export const refreshUgcPayout=async(env,id)=>{env.refreshedPayout=id;return {ok:!env.refreshFail}};`
};
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile,
 plugins:[{name:'dependencies',setup(b){b.onResolve({filter:/^\.\/|^\.\.\//},args=>{const name=args.path.split('/').at(-1);return stubs[name]?{path:name,namespace:'fixture'}:undefined;});b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path]}));}}]});
const cloud=await import(pathToFileURL(outfile));
const dispatchFile=join(dir,'dispatch.mjs');
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-dispatch.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:dispatchFile});
const {dispatchDianaCloud,latestOriginalIsVideo}=await import(pathToFileURL(dispatchFile));
const lockFile=join(dir,'lock.mjs');
await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-lock.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:lockFile});
const {reserveDianaCloud,releaseDianaCloud,readDianaCloudLock}=await import(pathToFileURL(lockFile));
const questionFile=join(dir,'question.mjs');
await build({entryPoints:[fileURLToPath(new URL('./ugc-hard-question.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:questionFile});
const {answerHardQuestion}=await import(pathToFileURL(questionFile));
rmSync(dir,{recursive:true});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_content(id TEXT PRIMARY KEY,creator_id TEXT,product_status TEXT);
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
 await assert.rejects(cloud.executeCloudPayout(f.env,'payout1',f.event,'person'),/owner_approval_required/);
 assert.equal(f.env.executedPayout,undefined);assert.equal(f.env.refreshedPayout,undefined);

});
test('legacy cloud payment callback fails closed even when provider refresh is unavailable',async t=>{
 const f=fixture(t);f.env.refreshFail=true;
 await assert.rejects(cloud.executeCloudPayout(f.env,'payout1',f.event,'person'),/owner_approval_required/);
 assert.equal(f.env.executedPayout,undefined);assert.equal(f.env.refreshedPayout,undefined);
 assert.equal(f.state('diana_payout_refresh_pending:payout1'),undefined);
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
 const f=fixture(t);f.originals[0].message='';f.originals[0].is_unsupported=true;let source=await cloud.readCloudConversation(f.env,f.event);
 assert.equal((await cloud.prepareCloudDecision(f.env,source.key)).status,'media_wait');assert.equal(f.env.inferences.length,0);
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
 instances.set(creates[0].id,'complete');f.originals[0].message='';f.originals[0].attachments={data:[{mime_type:'image/jpeg'}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review'});
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
test('recovery only delivers a verified gratitude once through the original durable plan',async t=>{
 const f=fixture(t),event={...f.event,recovery:true};f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};
 globalThis.__videoFixture={checks:[{product:'yes',observed:{product_name:'TERMO'},requisites:{},unresolved_required:[]}]};
 const old={status:'needs_review',reason:'Нужно посмотреть видео'};f.set('diana_cloud_event:'+event.event_id,old);
 const {draft}=await f.prepare(event);const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Спасибо за видео!');
 await cloud.completeCloudEvent(f.env,event,result);await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);assert.equal(f.state('diana_message_done:chat'),'incoming');
 assert.deepEqual(JSON.parse(f.state('diana_cloud_event:'+event.event_id)),old);assert.equal(f.state('diana_round_alarm:chat'),undefined);
});
test('recovery never delivers an unverified model reply',async t=>{
 const f=fixture(t),event={...f.event,recovery:true};const {draft}=await f.prepare(event);const result=await cloud.deliverCloudDecision(f.env,draft.key);
 assert.equal(result.reason,'video_recovery_only_verified_thanks_allowed');assert.equal(f.sends.length,0);
});
test('recovery stops if existing delivery for that original was sent or uncertain',async t=>{
 for(const status of ['sent','sending','pending']){
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

test('a competing older plan created after recovery read cannot be sent by recovery',async t=>{
 const f=fixture(t),event={...f.event,recovery:true};f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};
 globalThis.__videoFixture={checks:[{product:'yes',observed:{product_name:'TERMO'},requisites:{},unresolved_required:[]}]};
 const {draft}=await f.prepare(event);const key='ig_reply_delivery:chat:'+event.at;
 f.set(key,{version:1,conversationId:'chat',incomingAt:event.at,handle:'creator',status:'pending',items:[{status:'pending',text:'Старое несвязанное сообщение'}]});
 const outcome=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(outcome.reason,'recovery_existing_plan_differs');assert.equal(f.sends.length,0);
});

test('failed recovery creation retries only positively missing instance with the same ID',async t=>{
 const f=fixture(t),ids=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть'});
 let fail=true;f.env.DIANA_CLOUD={async create(x){ids.push(x.id);if(fail){fail=false;throw Error('create failure');}},async get(){return{async status(){throw Error('workflow not found')}}}};
 const now=Date.parse('2026-11-11T08:00:00+03:00');const first=await dispatchDianaCloud(f.env,undefined,now);assert.equal(first.reason,'video_recovery_create_missing_retry_same_id');
 assert.equal(JSON.parse(f.state('diana_video_recovery_result:'+f.event.event_id)).status,'create_missing');
 assert.equal((await dispatchDianaCloud(f.env,undefined,now+1000)).dispatched,true);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
});
test('unknown recovery creation outcome preserves the lock and is not replayed',async t=>{
 const f=fixture(t),ids=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть'});
 f.env.DIANA_CLOUD={async create(x){ids.push(x.id);throw Error('create timeout')},async get(){return{async status(){throw Error('network unavailable')}}}};
 const now=Date.parse('2026-11-11T08:00:00+03:00');await assert.rejects(dispatchDianaCloud(f.env,undefined,now),/create timeout/);
 assert.equal(JSON.parse(f.state('diana_video_recovery_result:'+f.event.event_id)).status,'queued');assert.ok(await readDianaCloudLock(f.env));assert.equal(ids.length,1);
});
test('interrupted recovery create is retried with same ID only after grace and explicit absence',async t=>{
 const f=fixture(t),ids=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть'});
 const id='direct-v1-'+'a'.repeat(64);f.set('diana_video_recovery_result:'+f.event.event_id,{status:'queued',workflow_id:id,event_id:f.event.event_id,recovery:true});
 f.set('diana_cloud_active',id);await reserveDianaCloud(f.env,{kind:'direct',id});f.db.prepare('UPDATE crm_sync_state SET updated_at=? WHERE key=?').run(Date.now()-181000,'diana_video_recovery_result:'+f.event.event_id);
 f.env.DIANA_CLOUD={async create(x){ids.push(x.id)},async get(){return{async status(){throw Error('workflow not found')}}}};
 const result=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'));assert.equal(result.dispatched,true);assert.deepEqual(ids,[id]);
});

test('recovery interrupted before active marker can retry only same proven-missing ID',async t=>{
 const f=fixture(t),ids=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть'});
 const id='direct-v1-'+'b'.repeat(64);f.set('diana_video_recovery_result:'+f.event.event_id,{status:'queued',workflow_id:id,event_id:f.event.event_id,recovery:true});
 await reserveDianaCloud(f.env,{kind:'direct',id});f.db.prepare('UPDATE crm_sync_state SET updated_at=? WHERE key=?').run(Date.now()-181000,'diana_video_recovery_result:'+f.event.event_id);
 f.env.DIANA_CLOUD={async create(x){ids.push(x.id)},async get(){return{async status(){throw Error('workflow not found')}}}};
 const result=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'));assert.equal(result.dispatched,true);assert.deepEqual(ids,[id]);
});

test('priority scan never probes old review cases and dispatches new work first',async t=>{
 const f=fixture(t),created=[];f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нужно посмотреть видео'});
 const now=Date.parse('2026-11-11T08:00:00+03:00');let result=await dispatchDianaCloud(f.env,f.event.event_id,now);
 assert.equal(result.dispatched,false);assert.equal(f.graphReads.length,0);
 const fresh={...f.event,cid:'new-chat',message_id:'new',event_id:'message:new',at:'2026-11-09T08:59:00Z'};f.set('diana_round_alarm:new-chat',fresh);
 f.env.DIANA_CLOUD={async create(x){created.push(x)}};result=await dispatchDianaCloud(f.env,undefined,now);
 assert.equal(result.dispatched,true);assert.equal(created[0].params.event_id,'message:new');assert.equal(f.graphReads.length,0);
});
test('ordinary recovery probes at most one candidate and rotates past non-video cases',async t=>{
 const f=fixture(t);f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Проверить'});
 const other={...f.event,cid:'second',message_id:'second-id',event_id:'message:second-id',at:'2026-11-09T08:59:00Z'};f.set('diana_round_alarm:second',other);f.set('diana_cloud_event:'+other.event_id,{status:'needs_review',reason:'Проверить'});
 const seen=[];t.mock.method(globalThis,'fetch',async url=>{const u=new URL(url);if(u.searchParams.get('fields')==='access_token')return Response.json({access_token:'page'});seen.push(u.pathname);return Response.json({messages:{data:[{id:u.pathname.endsWith('/chat')?'incoming':'second-id',from:{id:'person'},attachments:{data:[{image_data:{url:'https://x.fbcdn.net/i'}}]}}]}})});
 const now=Date.parse('2026-11-11T08:00:00+03:00');await dispatchDianaCloud(f.env,undefined,now);assert.equal(seen.length,1);await dispatchDianaCloud(f.env,undefined,now+1000);assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);
});
test('a stalled Meta recovery probe releases the scan within the shared four-second deadline',async t=>{
 const logs=[];t.mock.method(console,'log',line=>logs.push(line));
 const f=fixture(t);f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Проверить'});
 t.mock.method(globalThis,'fetch',async(_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
 const started=Date.now();let watchdog;
 try{
  // AbortSignal.timeout() is unref'ed in Node 20/22; this referenced
  // watchdog keeps the event loop alive and fails if the real deadline breaks.
  const result=await Promise.race([
   dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00')),
   new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('recovery probe exceeded six seconds')),6000);}),
  ]);
  assert.equal(result.dispatched,false);assert.ok(Date.now()-started<6000);assert.equal(f.state('diana_video_recovery_result:'+f.event.event_id),undefined);
  assert.equal(JSON.parse(logs.at(-1)).outcome,'timeout');
 }finally{clearTimeout(watchdog);}
});

test('recovery probe logs only closed outcome categories, without identifiers or Meta payloads',async t=>{
 const logs=[];t.mock.method(console,'log',line=>logs.push(line));let scenario='video';
 t.mock.method(globalThis,'fetch',async url=>{
  if(scenario==='meta_unavailable')throw Error('sensitive-error-secret');
  const u=new URL(url);if(u.searchParams.get('fields')==='access_token')return Response.json({access_token:'sensitive-page-token'});
  if(scenario==='original_unavailable')return Response.json({messages:{data:[]}});
  const msg={id:scenario==='stale'?'different-private-id':'private-message',from:{id:'private-sender'}};
  if(scenario!=='attachments_unavailable')msg.attachments={data:scenario==='video'?[{video_data:{url:'https://private.example/secret'}}]:scenario==='nonvideo'?[{mime_type:'image/jpeg'}]:[]};
  return Response.json({messages:{data:[msg]}});
 });
 const env={META_IG_MESSAGING_TOKEN:'sensitive-token'},event={cid:'private-conversation',message_id:'private-message',event_id:'message:private-message'};
 for(const value of ['video','nonvideo','no_attachments','stale','original_unavailable','attachments_unavailable','meta_unavailable']){
  scenario=value;const found=await latestOriginalIsVideo(env,event);assert.equal(found,value==='video');
  const record=JSON.parse(logs.at(-1));assert.deepEqual(Object.keys(record).sort(),['elapsed_ms','event','outcome']);assert.equal(record.event,'diana_video_recovery_probe');assert.equal(record.outcome,value);
  assert.doesNotMatch(logs.at(-1),/private|sensitive|example|secret/);
 }
 assert.equal(await latestOriginalIsVideo({},event),false);assert.equal(JSON.parse(logs.at(-1)).outcome,'credential_unavailable');
 assert.equal(await latestOriginalIsVideo(env,{...event,event_id:'invalid'}),false);assert.equal(JSON.parse(logs.at(-1)).outcome,'invalid_event');
});

test('full readable requisites then an unreadable attachment receive a single processing acknowledgement after a durable signal',async t=>{
 const f=fixture(t);const details={id:'details',from:{id:'person',username:'creator'},message:'89990000000 Сбербанк Елена',created_time:'2026-11-09T09:00:00Z'};
 f.originals=[{id:'unknown',from:{id:'person',username:'creator'},message:'',is_unsupported:true,created_time:'2026-11-09T09:00:01Z'},details];
 const event={...f.event,message_id:'unknown',event_id:'message:unknown',at:'2026-11-09T09:00:01.000Z',recovery:true,recoveryKind:'unsupported',mediaRetried:true};f.set('diana_round_alarm:chat',event);
 const source=await cloud.readCloudConversation(f.env,event);const context=await cloud.prepareCloudDecision(f.env,source.key);assert.equal(context.status,'ready');
 assert.equal(f.env.partialIntake.cycle_message_id,'details');assert.deepEqual(f.env.partialIntake.source_message_ids,['details']);
 const signal=JSON.parse(f.state('diana_payout_signal:'+event.event_id));assert.equal(signal.message_id,'details');assert.equal(signal.latest_message_id,'unknown');
 assert.equal(JSON.parse(f.state('diana_unreadable_media:unknown')).message_id,'unknown');
 const draft=await cloud.draftCloudDecision(f.env,context.key);assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'partial');
 const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[0].text,'Спасибо! Передали реквизиты в обработку.');
 await cloud.completeCloudEvent(f.env,event,result);await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);assert.equal(f.env.payoutHandoffs,undefined);assert.equal(f.env.executedPayout,undefined);assert.ok(f.state('diana_unreadable_media:unknown'));
});
test('a later clear text can be answered once while the earlier inaccessible media remains pending',async t=>{
 const f=fixture(t);f.originals=[{id:'clear',from:{id:'person',username:'creator'},message:'Забрала',created_time:'2026-11-09T09:00:02Z'},
 {id:'unknown',from:{id:'person',username:'creator'},message:'',is_unsupported:true,created_time:'2026-11-09T09:00:01Z'}];
 f.db.prepare("UPDATE ugc_creators SET lifecycle_stage='paid' WHERE id='creator-id'").run();
 const event={...f.event,message_id:'clear',event_id:'message:clear',at:'2026-11-09T09:00:02.000Z',recovery:true,recoveryKind:'text'};f.set('diana_round_alarm:chat',event);
 const old={status:'needs_review',reason:'Не удалось прочитать вложение'};f.set('diana_cloud_event:'+event.event_id,old);f.env.decision={...f.env.decision,reply:'Спасибо, что сообщили!',replies:['Спасибо, что сообщили!']};
 const {draft}=await f.prepare(event);assert.match(f.env.inferences[0].messages[0].content,/earlier incoming attachment is inaccessible/);assert.equal(f.state('diana_media_retry:'+event.event_id),undefined);
 assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'partial');const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'delivered');await cloud.completeCloudEvent(f.env,event,out);
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Спасибо, что сообщили!');assert.equal(f.db.prepare("SELECT lifecycle_stage FROM ugc_creators WHERE id='creator-id'").get().lifecycle_stage,'creation');assert.ok(f.state('diana_creator_progress:'+event.event_id));assert.ok(f.state('diana_unreadable_media:unknown'));
 const observation=JSON.parse(f.state('diana_learning_observation:'+event.event_id));const evidence=JSON.parse(f.files.get(observation.evidenceKey));assert.equal(observation.status,'pending_owner_review');assert.equal(evidence.sent[0].text,'Спасибо, что сообщили!');assert.ok(evidence.unreadable_message_ids.includes('unknown'));assert.equal(evidence.sent[0].message_id,'out-1');assert.ok(f.state('diana_text_recovery_unresolved:'+event.event_id));assert.deepEqual(JSON.parse(f.state('diana_cloud_event:'+event.event_id)),old);
 await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);assert.equal(f.env.executedPayout,undefined);
});
test('a new clear question can receive an independent durable reply while the old review remains open',async t=>{
 const f=fixture(t);f.originals[0].message='Какие у вас условия?';const event={...f.event,recovery:true,recoveryKind:'text'};
 const old={status:'needs_review',reason:'Старое утверждение не подтверждено'};f.set('diana_cloud_event:'+event.event_id,old);
 f.env.decision={...f.env.decision,reply:'Вы заказываете товар, а мы возмещаем стоимость после подтверждения получения.',replies:['Вы заказываете товар, а мы возмещаем стоимость после подтверждения получения.']};
 const {draft}=await f.prepare(event);assert.match(f.env.inferences[0].messages[0].content,/verified current programme rules/);
 const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'delivered');await cloud.completeCloudEvent(f.env,event,out);assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,'Вы заказываете товар, а мы возмещаем стоимость после подтверждения получения.');
 assert.deepEqual(JSON.parse(f.state('diana_cloud_event:'+event.event_id)),old);assert.ok(f.state('diana_text_recovery_unresolved:'+event.event_id));await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);
});
test('plain original text gets its own recovery workflow, with no fabricated attachments',async t=>{
 const f=fixture(t),created=[];f.originals[0].message='Какие у вас условия?';f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Старое утверждение не подтверждено'});
 f.env.DIANA_CLOUD={async create(x){created.push(x)}};const out=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'));
 assert.equal(out.dispatched,true);assert.equal(created[0].params.recoveryKind,'text');assert.equal(created.length,1);assert.equal(f.sends.length,0);
});


test('a still-current unsupported original starts a separate safe intake-only recovery',async t=>{
 const f=fixture(t),created=[];f.originals[0].message='';f.originals[0].is_unsupported=true;f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Нельзя прочитать вложение'});
 f.env.DIANA_CLOUD={async create(x){created.push(x)}};const result=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:00:00+03:00'));
 assert.equal(result.dispatched,true);assert.equal(created[0].params.recoveryKind,'unsupported');assert.equal(f.sends.length,0);
});

test('technical recovery failure waits, verifies terminal status and retries with a bounded new attempt',async t=>{
 const f=fixture(t),created=[];f.originals[0].message='Какие у вас условия?';f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Старый review'});
 const now=Date.parse('2026-11-11T08:10:00+03:00'),oldId='direct-v1-'+'c'.repeat(64);let status='running';
 f.set('diana_video_recovery_result:'+f.event.event_id,{status:'failed',reason:'recovery_technical_retryable',workflow_id:oldId,recovery_attempt:1,at:now-1000});
 f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return{status}}}}};
 assert.equal((await dispatchDianaCloud(f.env,undefined,now)).dispatched,false);
 f.set('diana_video_recovery_result:'+f.event.event_id,{status:'failed',reason:'recovery_technical_retryable',workflow_id:oldId,recovery_attempt:1,at:now-181000});
 assert.equal((await dispatchDianaCloud(f.env,undefined,now)).dispatched,false);status='errored';
 assert.equal((await dispatchDianaCloud(f.env,undefined,now)).dispatched,true);assert.equal(created.length,1);assert.notEqual(created[0].id,oldId);assert.equal(created[0].params.recoveryAttempt,2);assert.equal(created[0].params.recoveryKind,'text');
 assert.equal(JSON.parse(f.state('diana_cloud_event:'+f.event.event_id)).reason,'Старый review');
});
test('payment-specific or exhausted recovery failures never restart automatically',async t=>{
 for(const prior of [{status:'failed',reason:'payout_execution_unknown',recovery_attempt:1},{status:'failed',reason:'recovery_technical_retryable',recovery_attempt:3}]){
  const f=fixture(t),created=[];f.originals[0].message='Какие у вас условия?';f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'Старый review'});
  const now=Date.parse('2026-11-11T08:10:00+03:00');f.set('diana_video_recovery_result:'+f.event.event_id,{...prior,workflow_id:'direct-v1-'+'d'.repeat(64),at:now-181000});
  f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return{status:'errored'}}}}};
  assert.equal((await dispatchDianaCloud(f.env,undefined,now)).dispatched,false);assert.equal(created.length,0);
 }
});

test('explicit receipt advances early stage without fabricating payout, while manual or later stages are preserved',async t=>{
 for(const [stage,manual,expected] of [['replied',false,'creation'],['agreed',false,'creation'],['posted',false,'posted'],['replied',true,'replied']]){
  const f=fixture(t);f.db.prepare('UPDATE ugc_creators SET lifecycle_stage=? WHERE id=?').run(stage,'creator-id');if(manual)f.set('manual_stage:creator-id',{to:'replied',at:1});f.originals[0].message='Забрала';
  const source=await cloud.readCloudConversation(f.env,f.event);assert.equal(source.status,'ready');assert.equal(f.db.prepare("SELECT lifecycle_stage FROM ugc_creators WHERE id='creator-id'").get().lifecycle_stage,expected);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);assert.equal(f.sends.length,0);
 }
});


test('order message with failed payout and earlier payment claim produces reconciliation without asserting money was received',async t=>{
 const f=fixture(t);f.originals=[{id:'order',from:{id:'person',username:'creator'},message:'Заказала 👍🏼',created_time:'2026-11-09T09:00:02Z'},{id:'prior-out',from:{id:'17841466350261166'},message:'Наконец-то получилось оплатить',created_time:'2026-11-09T09:00:01Z'}];
 f.db.prepare("INSERT INTO ugc_payouts(id,creator_id,status,amount_minor) VALUES('p1','creator-id','failed',45300)").run();
 const event={...f.event,message_id:'order',event_id:'message:order',at:'2026-11-09T09:00:02.000Z',recovery:true,recoveryKind:'text'};f.set('diana_round_alarm:chat',event);
 const {draft}=await f.prepare(event);const conflict=JSON.parse(f.state('diana_payout_reconciliation:'+event.event_id));assert.equal(conflict.reason,'provider_failed_prior_outgoing_payment_claim');assert.equal(conflict.prior_outgoing_message_id,'prior-out');
 assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'not_applicable');const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[0].text,'Спасибо, что сообщили! Когда получите товар, напишите, пожалуйста.');
 assert.doesNotMatch(f.sends[0].text,/перевод|оплатили|деньги/);assert.equal(f.env.executedPayout,undefined);assert.equal(f.env.payoutHandoffs,undefined);
});

test('unknown sender question gets an honest answer and a background reconciliation without payment claims',async t=>{
 const f=fixture(t);f.originals[0].message='От кого пришёл перевод?';f.env.decision={...f.env.decision,escalate:true,reply:null,reason:'Неизвестен отправитель'};
 const event={...f.event,recovery:true,recoveryKind:'text'};const {draft}=await f.prepare(event);
 const record=JSON.parse(f.state('diana_sender_reconciliation:'+event.event_id));assert.equal(record.reason,'sender_not_confirmed');
 assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'not_applicable');const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');
 assert.equal(f.sends[0].text,'Пока не могу подтвердить отправителя перевода.');assert.equal(f.env.executedPayout,undefined);await cloud.completeCloudEvent(f.env,event,result);
 const observation=JSON.parse(f.state('diana_learning_observation:'+event.event_id));const evidence=JSON.parse(f.files.get(observation.evidenceKey));assert.equal(evidence.decision_reason,'sender_not_confirmed');assert.equal(evidence.sent[0].text,f.sends[0].text);
});

test('review creates one Owner question with a ready draft; selection resumes through verified delivery',async t=>{
 const f=fixture(t),owner=[];f.env.DASORG_API_KEY='test-only';f.env.ORGANIZATION={fetch:async(_url,init)=>{owner.push(JSON.parse(init.body));return Response.json({ok:true,message_id:42});}};
 f.env.DIANA_WAKE={idFromName:()=>1,get:()=>({fetch:async()=>Response.json({dispatched:false})})};
 await cloud.readCloudConversation(f.env,f.event);
 const outcome={status:'needs_review',reason:'business_context_needs_owner'};await cloud.completeCloudEvent(f.env,f.event,outcome);await cloud.completeCloudEvent(f.env,f.event,outcome);
 assert.equal(owner.length,1);const plan=JSON.parse(f.state('diana_review_plan:'+f.event.event_id));assert.ok(plan.draft);assert.ok(plan.options['Отправить черновик']);
 const q=JSON.parse(f.state('ig_hard:42'));assert.equal(q.review_event_id,f.event.event_id);assert.equal(q.options['Отправить черновик'][0],plan.draft);
 const chosen=await answerHardQuestion(f.env,42,'Отправить черновик');assert.equal(chosen.handled,true);assert.ok(chosen.event_id);assert.equal(f.sends.length,0);
 const action=JSON.parse(f.state('diana_action_pending:'+chosen.event_id));assert.equal(action.task,'owner_choice');
 f.env.decision={...f.env.decision,reply:plan.draft,replies:[plan.draft]};const {draft}=await f.prepare(action);const sent=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(sent.status,'delivered');await cloud.completeCloudEvent(f.env,action,sent);
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].text,plan.draft);assert.ok(JSON.parse(f.state('ig_hard:42')).answered_at);
});
test('ambiguous Owner question delivery is never sent twice and keeps a ready plan',async t=>{
 const f=fixture(t);let tries=0;f.env.DASORG_API_KEY='test-only';f.env.ORGANIZATION={fetch:async()=>{tries++;throw Error('connection lost')}};
 await cloud.completeCloudEvent(f.env,f.event,{status:'needs_review',reason:'business_context_needs_owner'});await cloud.completeCloudEvent(f.env,f.event,{status:'needs_review',reason:'business_context_needs_owner'});
 assert.equal(tries,1);assert.equal(JSON.parse(f.state('diana_review_owner_intent:'+f.event.event_id)).status,'delivery_unknown');assert.ok(JSON.parse(f.state('diana_review_plan:'+f.event.event_id)).draft);
});
test('payment or delivery uncertainty offers no send action',async t=>{
 const f=fixture(t);await cloud.completeCloudEvent(f.env,f.event,{status:'needs_review',reason:'payment_provider_unknown'});
 const plan=JSON.parse(f.state('diana_review_plan:'+f.event.event_id));assert.equal(plan.next,'inspect_original_and_payment_receipts');assert.deepEqual(Object.values(plan.options),[null]);assert.equal(f.sends.length,0);
});


test('explicit order advances early stage to creation without implying a payment',async t=>{
 for(const [stage,manual,expected] of [['replied',false,'creation'],['cart',false,'creation'],['posted',false,'posted'],['replied',true,'replied']]){
  const f=fixture(t);f.db.prepare('UPDATE ugc_creators SET lifecycle_stage=? WHERE id=?').run(stage,'creator-id');if(manual)f.set('manual_stage:creator-id',{to:'replied',at:1});f.originals[0].message='Заказала 👍🏼';
  const source=await cloud.readCloudConversation(f.env,f.event);assert.equal(source.status,'ready');assert.equal(f.db.prepare("SELECT lifecycle_stage FROM ugc_creators WHERE id='creator-id'").get().lifecycle_stage,expected);
  if(expected==='creation')assert.equal(JSON.parse(f.state('diana_creator_progress:'+f.event.event_id)).confirmation_kind,'ordered');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);assert.equal(f.sends.length,0);
 }
});

test('friendly follow-up after an acknowledged video gets a warm reply without a publication push',async t=>{
 const f=fixture(t);f.originals=[{id:'friendly',from:{id:'person',username:'creator'},message:'Спасибо большое!',created_time:'2026-11-09T09:00:02Z'},{id:'prior-out',from:{id:'17841466350261166'},message:'Спасибо за видео!',created_time:'2026-11-09T09:00:01Z'}];
 const event={...f.event,message_id:'friendly',event_id:'message:friendly',at:'2026-11-09T09:00:02.000Z',recovery:true,recoveryKind:'text',mediaRetried:true};f.set('diana_round_alarm:chat',event);f.env.decision={...f.env.decision,reply:'Когда опубликуете?',replies:['Когда опубликуете?']};
 const {draft}=await f.prepare(event);const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[0].text,'Спасибо! Очень приятно 😊');assert.doesNotMatch(f.sends[0].text,/публикац|опублик/iu);
});
test('shared links are thanked once and remain independently unverified',async t=>{
 const f=fixture(t);f.originals[0].message='Опубликовала ещё и в TikTok https://www.tiktok.com/@creator/video/123456789';
 const event={...f.event,recovery:true,recoveryKind:'text'};f.env.decision={...f.env.decision,escalate:true,reply:null,reason:'ссылка не проверена'};
 const {draft}=await f.prepare(event);const pending=JSON.parse(f.state('diana_publication_pending:'+event.event_id));assert.equal(pending.verified,false);assert.equal(pending.links[0].platform,'tiktok');
 const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[0].text,'Спасибо, что поделились ссылками!');
 await cloud.completeCloudEvent(f.env,event,result);await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);assert.equal(JSON.parse(f.state('diana_publication_pending:'+event.event_id)).verified,false);
});

test('unsupported original is reopened by exact message ID; recovered image enters normal vision path',async t=>{
 const f=fixture(t);f.originals[0].message='';f.originals[0].is_unsupported=true;f.env.restored={incoming:JSON.stringify([{mime_type:'image/jpeg',image_data:{url:'https://x.fbcdn.net/image'}}])};
 const event={...f.event,recovery:true,recoveryKind:'unsupported'};const source=await cloud.readCloudConversation(f.env,event);const saved=JSON.parse(f.files.get(source.key));
 assert.equal(saved.history[0].recovered_media,true);assert.equal(saved.history[0].unsupported,false);assert.match(saved.history[0].attachments_json,/image_data/);
 const context=await cloud.prepareCloudDecision(f.env,source.key);assert.equal(context.status,'ready');assert.equal(f.state('diana_unreadable_media:incoming'),undefined);assert.equal(f.sends.length,0);
});
test('an empty Meta recovery remains unknown by exact ID but does not block later readable text',async t=>{
 const f=fixture(t);f.originals=[{id:'clear',from:{id:'person',username:'creator'},message:'Забрала',created_time:'2026-11-09T09:00:02Z'},{id:'unknown',from:{id:'person',username:'creator'},message:'',is_unsupported:true,created_time:'2026-11-09T09:00:01Z'}];f.env.restored={unknown:'[]'};
 const event={...f.event,message_id:'clear',event_id:'message:clear',at:'2026-11-09T09:00:02.000Z',recovery:true,recoveryKind:'text',mediaRetried:true};f.set('diana_round_alarm:chat',event);
 f.env.decision={...f.env.decision,reply:'Спасибо, что сообщили!',replies:['Спасибо, что сообщили!']};const {draft}=await f.prepare(event);
 assert.equal(JSON.parse(f.state('diana_unreadable_media:unknown')).reason,'meta_attachment_unavailable');const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[0].text,'Спасибо, что сообщили!');assert.doesNotMatch(f.sends[0].text,/пришлите|вложени/iu);
});

test('unavailable media waits three minutes without an answer or payment and keeps exact media IDs',async t=>{
 const f=fixture(t);f.originals[0].message='';f.originals[0].is_unsupported=true;
 const before=Date.now();const source=await cloud.readCloudConversation(f.env,f.event);const outcome=await cloud.prepareCloudDecision(f.env,source.key);
 assert.equal(outcome.status,'media_wait');assert.ok(outcome.retry_at>=before+180000);assert.ok(outcome.retry_at<=Date.now()+180000);
 const retry=JSON.parse(f.state('diana_media_retry:'+f.event.event_id));assert.deepEqual(retry.media_ids,['incoming']);assert.equal(f.sends.length,0);assert.equal(f.env.executedPayout,undefined);
 await cloud.completeCloudEvent(f.env,f.event,outcome);assert.equal(JSON.parse(f.state('diana_cloud_event:'+f.event.event_id)).status,'media_wait');assert.ok(f.state('diana_round_alarm:chat'));
});
test('waiting media does not block other chats and resumes once due with a new stable workflow',async t=>{
 const f=fixture(t),created=[];const now=Date.parse('2026-11-11T08:00:00+03:00');
 f.set('diana_cloud_event:'+f.event.event_id,{status:'media_wait',retry_at:now+180000});
 const fresh={...f.event,cid:'another',message_id:'new',event_id:'message:new',at:'2026-11-09T08:59:00Z'};f.set('diana_round_alarm:another',fresh);
 f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return{status:'running'}}}}};
 const first=await dispatchDianaCloud(f.env,undefined,now);assert.equal(first.dispatched,true);assert.equal(created[0].params.event_id,'message:new');
 const id=created[0].id;await releaseDianaCloud(f.env,{kind:'direct',id});f.set('diana_cloud_finished:'+id,{kind:'direct',id});f.db.prepare("DELETE FROM crm_sync_state WHERE key='diana_round_alarm:another'").run();
 const waiting=await dispatchDianaCloud(f.env,undefined,now+179999);assert.equal(waiting.reason,'media_retry_waiting');assert.equal(waiting.retry_at,now+180000);
 const ready=await dispatchDianaCloud(f.env,undefined,now+180000);assert.equal(ready.dispatched,true);assert.equal(created[1].params.mediaRetried,true);assert.notEqual(created[1].id,id);
});
test('review recovery resumes its media retry after the same three-minute delay',async t=>{
 const f=fixture(t),created=[];const now=Date.parse('2026-11-11T08:00:00+03:00');f.originals[0].message='';f.originals[0].is_unsupported=true;
 f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'неизвестное вложение'});f.set('diana_video_recovery_result:'+f.event.event_id,{status:'media_wait',retry_at:now+180000,workflow_id:'direct-v1-'+'e'.repeat(64)});
 f.env.DIANA_CLOUD={async create(x){created.push(x)}};
 const waiting=await dispatchDianaCloud(f.env,undefined,now);assert.equal(waiting.reason,'media_retry_waiting');assert.equal(created.length,0);
 const ready=await dispatchDianaCloud(f.env,undefined,now+180000);assert.equal(ready.dispatched,true);assert.equal(created[0].params.recoveryKind,'unsupported');assert.equal(created[0].params.mediaRetried,true);
});

test('seller missing on basket prompts once; author seller name continues without proof request',async t=>{
 const f=fixture(t);t.after(()=>delete globalThis.__imageFixture);f.originals[0].message='Вот корзина';f.originals[0].attachments={data:[{mime_type:'image/jpeg',image_data:{url:'https://x.fbcdn.net/image'}}]};
 f.env.screenshots={images:[{mediaType:'image/jpeg',data:'ZmFrZQ==',label:'fixture'}],unreadable:0,currentUnavailable:false,omitted:0};
 globalThis.__imageFixture={status:'unknown',checks:[{kind:'basket',product:'yes',amount:'yes',seller:'unknown',unresolved_required:['seller'],observed:{price:'453',currency:'RUB'},label:'Скриншот из входящего сообщения 2026-11-09T09:00:00.000Z, вложение 1.'}]};
 const first=await f.prepare();const sent=await cloud.deliverCloudDecision(f.env,first.draft.key);assert.equal(sent.status,'delivered');assert.equal(f.sends[0].text,'Подскажите, пожалуйста, название продавца товара.');await cloud.completeCloudEvent(f.env,f.event,sent);
 f.originals.unshift({id:'seller-answer',from:{id:'person',username:'creator'},message:'Das Experten',created_time:'2026-11-09T09:02:00Z'});const event={...f.event,message_id:'seller-answer',event_id:'message:seller-answer',at:'2026-11-09T09:02:00.000Z'};f.set('diana_round_alarm:chat',event);
 f.env.decision={...f.env.decision,reply:'Спасибо, продолжаем.',replies:['Спасибо, продолжаем.']};const second=await f.prepare(event);
 assert.match(f.env.inferences.at(-1).messages[0].content,/creator has supplied the seller name/i);const result=await cloud.deliverCloudDecision(f.env,second.draft.key);assert.equal(result.status,'delivered');assert.equal(f.sends[1].text,'Спасибо, продолжаем.');
 assert.doesNotMatch(f.sends[1].text,/скрин|доказ|продавц/iu);
});

test('ordinary uncertainty gets one safe continuation before Owner escalation, retaining real response evidence',async t=>{
 const f=fixture(t);f.originals[0].message='Хорошо, спасибо!';f.env.decisions=[{...f.env.decision,reply:null,replies:null,escalate:true,reason:'неизвестная деталь'}, {...f.env.decision,reply:'Спасибо, что сообщили!',replies:['Спасибо, что сообщили!'],escalate:false,reason:'понятная часть'}];
 const {draft}=await f.prepare();assert.equal(f.env.inferences.length,2);const sent=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(sent.status,'delivered');await cloud.completeCloudEvent(f.env,f.event,sent);
 const evidence=JSON.parse(f.files.get(JSON.parse(f.state('diana_learning_observation:'+f.event.event_id)).evidenceKey));assert.equal(evidence.learning_uncertainty,'неизвестная деталь');assert.equal(evidence.sent[0].text,'Спасибо, что сообщили!');assert.equal(f.state('diana_review_owner_intent:'+f.event.event_id),undefined);
});
test('a mandatory Owner decision is never bypassed by the ordinary uncertainty retry',async t=>{
 const f=fixture(t);f.originals[0].message='Хочу вернуть товар';f.env.decision={...f.env.decision,reply:'Конечно',replies:['Конечно'],escalate:false};
 const {draft}=await f.prepare();assert.equal(f.env.inferences.length,1);const result=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(result.status,'needs_review');assert.equal(f.sends.length,0);
});

test('unknown payout outcome preserves claim and can answer an independent question without asserting payment',async t=>{
 const f=fixture(t);f.originals[0].message='Реквизиты указала. Когда можно снимать?';const event={...f.event,recovery:true,recoveryKind:'text'};const {draft}=await f.prepare(event);
 const pending=await cloud.prepareUncertainPayoutReply(f.env,draft.key,'payout-existing');assert.equal(pending.status,'reply');assert.equal(JSON.parse(f.state('diana_payout_reconciliation:'+event.event_id)).reason,'provider_outcome_unknown');
 const sent=await cloud.deliverCloudDecision(f.env,pending.key);assert.equal(sent.status,'delivered');assert.equal(f.sends[0].text,'Спасибо за сообщение! Мы уточним информацию.');assert.doesNotMatch(f.sends[0].text,/перевели|оплатили|получили деньги/iu);
 await cloud.completeCloudEvent(f.env,event,sent);const observation=JSON.parse(f.state('diana_learning_observation:'+event.event_id));const evidence=JSON.parse(f.files.get(observation.evidenceKey));assert.equal(evidence.decision_reason,'payment_outcome_unknown');assert.equal(evidence.sent[0].text,f.sends[0].text);assert.equal(f.env.executedPayout,undefined);
});

test('readable text on the same unsupported message is answered without the media wait',async t=>{
 const f=fixture(t);f.originals[0].message='Спасибо, поняла!';f.originals[0].is_unsupported=true;
 const event={...f.event,recovery:true,recoveryKind:'unsupported'};f.env.decision={...f.env.decision,reply:'Спасибо, что сообщили!',replies:['Спасибо, что сообщили!']};
 const {draft}=await f.prepare(event);assert.equal(f.state('diana_media_retry:'+event.event_id),undefined);assert.ok(f.state('diana_unreadable_media:incoming'));
 const sent=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(sent.status,'delivered');assert.equal(f.sends[0].text,'Спасибо, что сообщили!');
});

test('recovery may acknowledge a receipt despite agreed flag without duplicate delivery or stage regression',async t=>{
 const f=fixture(t); f.originals[0].message='Забрала';f.db.prepare("UPDATE ugc_creators SET lifecycle_stage='creation' WHERE id='creator-id'").run();
 const event={...f.event,recovery:true,recoveryKind:'text'}; f.env.decision={...f.env.decision,reply:'Спасибо, что сообщили!',replies:['Спасибо, что сообщили!'],agreed:true};
 const {draft}=await f.prepare(event);const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'delivered');await cloud.completeCloudEvent(f.env,event,out);
 assert.equal(f.db.prepare("SELECT lifecycle_stage FROM ugc_creators WHERE id='creator-id'").get().lifecycle_stage,'creation');await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);
});
test('legacy text guard retries once only with completed workflow and absent delivery, without payout',async t=>{
 for(const blocked of ['none','delivery','done','running']){
  const f=fixture(t),created=[]; f.originals[0].message='Забрала';f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'old review'});
  f.set('diana_video_recovery_result:'+f.event.event_id,{status:'needs_review',reason:'text_recovery_requires_separate_review'});
  if(blocked==='delivery')f.set('ig_reply_delivery:chat:'+f.event.at,{status:'complete'});if(blocked==='done')f.set('diana_event_done:'+f.event.event_id,{verified:true});
  f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return {status:blocked==='running'?'running':'complete'}}}}};
  const out=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:10:00+03:00'));
  assert.equal(out.dispatched,blocked==='none');if(blocked!=='none'){assert.equal(created.length,0);continue;}
  assert.equal(created[0].params.skipPayout,true);assert.equal(created[0].params.recoveryAttempt,2);assert.equal(f.state('diana_recovery_skip_payout:'+f.event.event_id),'1');
  const event={...f.event,recovery:true,recoveryKind:'text',skipPayout:true};const {draft}=await f.prepare(event);assert.equal((await cloud.handoffCloudPayout(f.env,draft.key)).status,'not_applicable');assert.equal(f.env.executedPayout,undefined);
 }
});

test('video recheck outage is bounded, yields the lock, and exposes no sensitive error',async t=>{
 const f=fixture(t);f.originals[0].attachments={data:[{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]};f.env.failVideoRecheck=true;
 globalThis.__videoFixture={checks:[{product:'unknown',observed:{},requisites:{},unresolved_required:['phone']}]};
 const source=await cloud.readCloudConversation(f.env,f.event);
 for(let n=1;n<=3;n++){
  const out=await cloud.prepareCloudDecision(f.env,source.key);assert.equal(out.status,n<3?'media_wait':'needs_review');assert.equal(out.reason,'video_recheck_frame_extraction_unavailable');
  if(n<3)assert.ok(out.retry_at>Date.now()+179000);const receipt=JSON.parse(f.state('diana_video_recheck_retry:'+f.event.event_id));assert.equal(receipt.count,n);assert.equal(receipt.stage,'frame_extraction');assert.doesNotMatch(JSON.stringify(receipt),/sensitive|fbcdn/);
 }
 assert.equal(f.sends.length,0);assert.equal(f.env.executedPayout,undefined);assert.equal(f.env.payoutHandoffs,undefined);
});
test('legacy video review retries once only when original and completed workflow remain safe',async t=>{
 for(const blocked of ['none','delivery','done','running']){
  const f=fixture(t),created=[];f.originals[0].attachments={data:[{video_data:{url:'https://x.fbcdn.net/v'}}]};f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'old review'});
  f.set('diana_video_recovery_result:'+f.event.event_id,{status:'needs_review',reason:'video_requisites_need_verified_payout_source'});
  if(blocked==='delivery')f.set('ig_reply_delivery:chat:'+f.event.at,{status:'complete'});if(blocked==='done')f.set('diana_event_done:'+f.event.event_id,{verified:true});
  f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return {status:blocked==='running'?'running':'complete'}}}}};
  const out=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:10:00+03:00'));assert.equal(out.dispatched,blocked==='none');
  if(blocked==='none'){assert.equal(created[0].params.recoveryKind,'video');assert.equal(created[0].params.recoveryAttempt,2);}else assert.equal(created.length,0);
  assert.equal(f.sends.length,0);assert.equal(f.env.executedPayout,undefined);
 }
});

test('seller answer after later screenshots continues without claiming unverified seller or payment',async t=>{
 const f=fixture(t);t.after(()=>delete globalThis.__imageFixture);
 f.originals=[{id:'answer',from:{id:'person',username:'creator'},message:'Das Experten Eurasia Ltd.\nСкрины из карточки',created_time:'2026-11-09T09:03:00Z'},
 {id:'question',from:{id:'17841466350261166'},message:'Подскажите, пожалуйста, как называется именно продавец в карточке товара?',created_time:'2026-11-09T09:02:00Z'},
 {id:'later',from:{id:'person',username:'creator'},message:'',created_time:'2026-11-09T09:01:00Z'},
 {id:'basket',from:{id:'person',username:'creator'},message:'Вот корзина',created_time:'2026-11-09T09:00:00Z'}];
 f.env.screenshots={images:[{mediaType:'image/jpeg',data:'ZmFrZQ==',label:'fixture'}],unreadable:0,currentUnavailable:false,omitted:0};
 globalThis.__imageFixture={status:'unknown',checks:[{kind:'basket',product:'yes',amount:'yes',seller:'unknown',unresolved_required:['seller'],observed:{price:'453'},label:'Скриншот из входящего сообщения 2026-11-09T09:00:00.000Z, вложение 1.'},{kind:'other',product:'unknown',amount:'unknown',seller:'unknown',unresolved_required:['seller'],observed:{},label:'later'}]};
 f.env.decision={...f.env.decision,reply:null,replies:null,escalate:true,reason:'Продавца надо подтвердить по реестру'};
 const event={...f.event,message_id:'answer',event_id:'message:answer',at:'2026-11-09T09:03:00.000Z',recovery:true,recoveryKind:'text'};f.set('diana_round_alarm:chat',event);
 const {draft}=await f.prepare(event);const out=await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(out.status,'delivered');assert.equal(f.sends[0].text,'Спасибо, что уточнили!');await cloud.completeCloudEvent(f.env,event,out);
 await cloud.deliverCloudDecision(f.env,draft.key);assert.equal(f.sends.length,1);assert.equal(f.env.executedPayout,undefined);
});
test('legacy seller verification review retries once only after prior workflow and absent delivery',async t=>{
 const f=fixture(t),created=[];f.originals[0].message='Das Experten Eurasia Ltd.';f.set('diana_cloud_event:'+f.event.event_id,{status:'needs_review',reason:'old review'});f.set('diana_video_recovery_result:'+f.event.event_id,{status:'needs_review',reason:'Продавца нельзя подтвердить без сверки с реестром'});
 f.env.DIANA_CLOUD={async create(x){created.push(x)},async get(){return{async status(){return {status:'complete'}}}}};const out=await dispatchDianaCloud(f.env,undefined,Date.parse('2026-11-11T08:10:00+03:00'));assert.equal(out.dispatched,true);assert.equal(created[0].params.skipPayout,true);assert.equal(created[0].params.recoveryAttempt,2);assert.equal(f.sends.length,0);
});
