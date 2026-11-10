import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'payout-source-'));
await createRequire(import.meta.url)('esbuild').build({entryPoints:[fileURLToPath(new URL('./ugc-payout-source.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'source.mjs'),plugins:[{name:'save-boundary',setup(b){b.onResolve({filter:/(?:ugc-(?:payout-intake|cart-review)|ig-dm-image-cache|diana-subscription-vision\.mjs|diana-subscription\.mjs)$/},()=>({path:'save',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const imageUrls=s=>JSON.parse(s||"[]").filter(a=>a.image_data).map(a=>a.image_data.url);export const loadInstagramImage=async(_env,id)=>{if(id!==undefined)throw Error("image cache used");return {mediaType:"image/jpeg",data:"ZmFrZQ=="};};export const checkSubscriptionImages=async()=>globalThis.__imageCheck;export const subscriptionInfer=()=>()=>{};export const reviewPayoutCart=async()=>globalThis.__review??({status:"pending"}),payoutImagePolicy=async()=>({});export const prepareCreatorPayout=async(_e,facts)=>{globalThis.__intake.push(facts);return globalThis.__intakeResult??{registered:true,id:"payout1"}}'}));}}]});
const {ingestCreatorPayouts}=await import(pathToFileURL(join(dir,'source.mjs')));rmSync(dir,{recursive:true});
function fixture(t,existing=null,scenario={}){
 const original={id:'details',created_time:new Date(Date.now()-60000).toISOString(),from:{id:'creator',username:'alice'},message:'89990000000 ТБанк Елена'};
 if(scenario.image){original.message='';original.attachments={data:[{mime_type:'image/jpeg',image_data:{url:'https://x.fbcdn.net/screenshot'}}]};}
 const reply={id:'ack',created_time:new Date().toISOString(),from:{id:'17841466350261166',username:'dasexperten'},message:'Данные получила'};
 const archived=[];globalThis.__intake=[];globalThis.__intakeResult=null;globalThis.__review=null;
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.method,undefined);return Response.json(url.includes('conversations?')?{data:[{id:'chat',messages:{data:[reply,original]}}]}:url.includes('/chat?')?{id:'chat',messages:{data:[original]}}:{access_token:'test-page'})});
 const DB={prepare(sql){let p=[];return{bind(...v){p=v;return this},sql,get params(){return p},async all(){return{results:archived}},async first(){if(sql.includes('FROM ugc_payouts'))return existing;return null}}},async batch(qs){for(const q of qs){const p=q.params;archived.push({id:p[0],direction:p[2],from_username:p[4],text:p[5],created_at:p[7]})}return[]}};
 return{DB,META_IG_MESSAGING_TOKEN:'test'};
}
test('live source is archived before intake even when our acknowledgement is newest',async t=>{
 assert.equal(await ingestCreatorPayouts(fixture(t)),1);assert.equal(globalThis.__intake.length,1);assert.equal(globalThis.__intake[0].handle,'alice');assert.equal(globalThis.__intake[0].first_name,'Елена');assert.deepEqual(globalThis.__intake[0].source_message_ids,['details']);
});
test('a recent paid creator never gets a new payout from repeated details',async t=>{
 assert.equal(await ingestCreatorPayouts(fixture(t,{id:'paid',status:'paid',konsol_payment_id:'sent'})),0);assert.equal(globalThis.__intake.length,0);
});
test('unavailable original source fails the payout intake visibly',async t=>{
 const env=fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message:'unavailable'}},{status:503}));await assert.rejects(ingestCreatorPayouts(env),/payment_source_unavailable/);assert.equal(globalThis.__intake.length,0);
});
test('a clarification outcome is not counted as a registered payout',async t=>{
 const env=fixture(t);globalThis.__intakeResult={registered:false,outcome:'clarification_required'};
 assert.equal(await ingestCreatorPayouts(env),0);assert.equal(globalThis.__intake.length,1);
});
test('Diana target requires original matching details and confirmed cart amount',async t=>{
 const env=fixture(t);globalThis.__review={status:'confirmed',amount_minor:45300};
 const target={conversation_id:'chat',message_id:'details',phone:'+79990000000',bank:'100000000004',first_name:'Елена',amount_minor:45300,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
 assert.deepEqual(await ingestCreatorPayouts(env,target),{registered:1,payout_id:'payout1'});assert.equal(globalThis.__intake.length,1);
 await assert.rejects(ingestCreatorPayouts(env,{...target,bank:'100000000111'}),/facts_do_not_match/);
 await assert.rejects(ingestCreatorPayouts(env,{...target,amount_minor:45400}),/amount_not_verified/);
 await assert.rejects(ingestCreatorPayouts(env,{...target,originals:[{id:'details',direction:'in',text:'changed'}]}),/original_archive_mismatch/);
});
test('a previously saved amount cannot replace a newer cart',async t=>{
 const env=fixture(t,{id:'p1',status:'awaiting_approval',creator_id:'c1',amount_minor:45300});
 globalThis.__review={status:'confirmed',amount_minor:45400};
 const target={conversation_id:'chat',message_id:'details',phone:'+79990000000',bank:'100000000004',first_name:'Елена',amount_minor:45300,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
 await assert.rejects(ingestCreatorPayouts(env,target),/payment_intake_failed/);
 assert.equal(globalThis.__intake.length,0);
});

test('video payout uses two original frame proofs and the current cart, not synthetic message text',async t=>{
 const env=fixture(t);globalThis.__review={status:'confirmed',amount_minor:45300};
 const frames=[{sourceMessageId:'details',videoSha256:'abc',data:'same'}];
 const check={kind:'other',requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:null,currency:null,card:null},unresolved_required:[]};
 let second={frames,videoCheck:{checks:[check]}};const first={frames,videoCheck:{checks:[check]}};
 env.DOCS={get:async key=>({json:async()=>key.endsWith('video-evidence.json')?first:second})};
 const target={conversation_id:'chat',message_id:'details',phone:'',bank:'',first_name:'',amount_minor:1,video:true,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
 assert.deepEqual(await ingestCreatorPayouts(env,target),{registered:1,payout_id:'payout1'});assert.equal(globalThis.__intake.at(-1).amount_minor,45300);assert.deepEqual(globalThis.__intake.at(-1).source_message_ids,['details']);
 second={frames,videoCheck:{checks:[{...check,requisites:{...check.requisites,phone:'89990000001'}}]}};
 await assert.rejects(ingestCreatorPayouts(env,target),/video_payout_source_unverified/);
});

test('video requisites cannot bypass current cart or a conflicting video amount',async t=>{
 const env=fixture(t);const frames=[{sourceMessageId:'details',videoSha256:'abc',data:'same'}];
 const check={kind:'other',requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:'455',currency:'RUB',card:null},unresolved_required:[]};
 const proof={frames,videoCheck:{checks:[check]}};env.DOCS={get:async()=>({json:async()=>proof})};
 const target={conversation_id:'chat',message_id:'details',phone:'',bank:'',first_name:'',amount_minor:1,video:true,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
 globalThis.__review={status:'confirmed',amount_minor:45300};await assert.rejects(ingestCreatorPayouts(env,target),/amount_not_verified/);assert.equal(globalThis.__intake.length,0);
 globalThis.__review={status:'pending'};await assert.rejects(ingestCreatorPayouts(env,target),/payment_intake_failed/);assert.equal(globalThis.__intake.length,0);
});


test('a newer video showing a cart or unreadable frame cannot authorize an older cart',async t=>{
 const env=fixture(t);globalThis.__review={status:'confirmed',amount_minor:45300};
 const frames=[{sourceMessageId:'details',videoSha256:'abc',data:'same'}];
 const target={conversation_id:'chat',message_id:'details',phone:'',bank:'',first_name:'',amount_minor:1,video:true,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
 for(const kind of ['basket','order','unknown']){const check={kind,requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:null,currency:null,card:null},unresolved_required:[]};const proof={frames,videoCheck:{checks:[check]}};env.DOCS={get:async()=>({json:async()=>proof})};
  await assert.rejects(ingestCreatorPayouts(env,target),/video_cart_requires_review/);assert.equal(globalThis.__intake.length,0);}
});


test('targeted screenshot requisites require independently reread original screenshot',async t=>{
 const env=fixture(t,null,{image:true});globalThis.__review={status:'confirmed',amount_minor:45300};
 const target={conversation_id:'chat',message_id:'details',phone:'+79990000000',bank:'100000000004',first_name:'Елена',amount_minor:45300,image:true,originals:[{id:'details',direction:'in',text:''}]};
 globalThis.__imageCheck={checks:[{requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:null,currency:null,card:null},unresolved_required:[]}]};
 assert.deepEqual(await ingestCreatorPayouts(env,target),{registered:1,payout_id:'payout1'});assert.equal(globalThis.__intake.at(-1).phone,'89990000000');
 globalThis.__imageCheck.checks[0].requisites.phone='89990000001';
 await assert.rejects(ingestCreatorPayouts(env,target),/facts_do_not_match_original/);
 globalThis.__imageCheck.checks[0].unresolved_required=['bank'];
 await assert.rejects(ingestCreatorPayouts(env,target),/image_payout_source_unverified/);
});

test('video recovery never registers a second payout for already sent or claimed original',async t=>{
 for(const existing of [{id:'p',status:'paid',konsol_payment_id:'sent'},{id:'p',status:'approved',execute_claim:'claimed'}]){
  const env=fixture(t,existing),frames=[{sourceMessageId:'details',videoSha256:'abc',data:'same'}];globalThis.__review={status:'confirmed',amount_minor:45300};
  const check={kind:'other',requisites:{holder_name:'Елена',bank:'Т-Банк',phone:'89990000000',amount:null,currency:null,card:null},unresolved_required:[]};
  const proof={frames,videoCheck:{checks:[check]}};const paths=[];env.DOCS={get:async key=>{paths.push(key);return {json:async()=>proof}}};
  const target={conversation_id:'chat',message_id:'details',phone:'',bank:'',first_name:'',amount_minor:1,video:true,recovery:true,originals:[{id:'details',direction:'in',text:'89990000000 ТБанк Елена'}]};
  const result=await ingestCreatorPayouts(env,target);assert.equal(result.registered,0);assert.equal(result.payout_id,null);assert.equal(globalThis.__intake.length,0);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('video-recovery:message:details'));const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');assert.ok(paths.every(p=>p.includes('/'+hash+'/')));
 }
});
