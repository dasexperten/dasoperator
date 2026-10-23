import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'ugc-reply-'));
const outfile = join(dir, 'reply.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ig-dm-reply.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'no-external-effects', setup(b) {
    b.onResolve({filter: /^\.\/(llm|ig-dm-watch|owner-telegram|ig-dm-attachments|diana-context\.mjs|diana-image-check\.mjs)$/}, a => ({path:a.path, namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'}, a => ({contents: a.path==='./llm'
      ? 'export const callFlash=async(messages)=>{globalThis.__ugcTest.voiceCalls=(globalThis.__ugcTest.voiceCalls??0)+1;if(globalThis.__ugcTest.voiceError)throw Error("voice");return {text:globalThis.__ugcTest.voiceVerdicts?.length?globalThis.__ugcTest.voiceVerdicts.shift():\'{"ok":true,"why":""}\'}}; export const callPro=(messages)=>globalThis.__ugcTest.generate(messages); export const callVision=(messages)=>{globalThis.__ugcTest.visionCalled=true;return globalThis.__ugcTest.generate(messages)};'
      : a.path==='./diana-context.mjs' ? 'export const prepareDianaContext=async()=>{if(globalThis.__ugcTest.contextError)throw Error("context");globalThis.__ugcTest.contextReady=true;return {system:"Full Diana JEV context",imagePolicy:{},receipt:{method:"jev"}}};'
      : a.path==='./diana-image-check.mjs' ? 'export const checkDianaImages=async()=>{if(globalThis.__ugcTest.jevImageError)throw Error("JEV image");return globalThis.__ugcTest.imageCheck??{status:"yes",reasons:[],checks:[]}};'
      : a.path==='./ig-dm-attachments' ? 'export const incomingScreenshots=async()=>{if(globalThis.__ugcTest.imageError)throw Error("image");return {images:globalThis.__ugcTest.screenshots??[],unreadable:globalThis.__ugcTest.unreadable??0}};'
      : a.path==='./owner-telegram' ? 'export const sendOwnerTelegram=()=>globalThis.__ugcTest.notify(); export const sendOwnerQuestion=(_e,text,buttons)=>globalThis.__ugcTest.ask(text,buttons);'
      : 'export const IG_UNSUPPORTED="unsupported"; export const refreshIgAttachments=async()=>globalThis.__ugcTest.freshAttachments??null; export const lastWordIsBlogger=()=>globalThis.__ugcTest.live; export const sendIgDirect=(...args)=>globalThis.__ugcTest.send(...args); export const sendIgCards=(...args)=>globalThis.__ugcTest.cards(...args);' }));
  }}] });
const { igDmReply, jevSure, surnameWritten } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive:true });

test('missing current attachment metadata is repaired internally or stays pending without a resend request',async()=>{
 const f=fixture();f.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:f.t}];
 await igDmReply(f.env);assert.equal(incident(f).reason,'current_attachment_metadata_unavailable');assert.equal(f.sent.length,0);assert.equal(f.systems.length,0);
 const g=fixture();g.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:g.t}];g.freshAttachments='[{"image_data":{"url":"https://lookaside.fbsbx.com/image"}}]';
 await igDmReply(g.env);assert.equal(g.sent.length,1);assert.equal(g.history[0].attachments_json,g.freshAttachments);
 // Owner 2026-10-18: Instagram confirms an empty item (a like, an unsupported sticker) — the text before it is answered.
 const e=fixture();e.history=[{direction:'in',text:'89511688874 озон Сотова Ксения',created_at:e.t},{id:'blank',direction:'in',text:null,attachments_json:null,created_at:e.t}];e.freshAttachments='[]';
 await igDmReply(e.env);assert.equal(e.sent.length,1);assert.equal(e.states.has('ig_reply_escalated:'+e.cid),false);
});
test.skip('a photo programs cannot open goes to the Owner first, never «did not arrive» (Owner 2026-10-18) — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 // Fresh photo: Diana waits for the Owner — nothing is sent, the card asks him to look.
 const h=fixture();h.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:h.t}];h.freshAttachments='unsupported';
 await igDmReply(h.env);assert.equal(h.sent.length,0);assert.equal(JSON.parse(h.states.get('ig_reply_escalated:'+h.cid)).reason,'photo_for_owner');
 // 35 minutes without the Owner: a soft ask goes out; a basket she never saw is not confirmed.
 const old=new Date(Date.now()-35*60_000).toISOString();
 const u=fixture();u.t=old;u.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:old}];u.freshAttachments='unsupported';
 u.raws=[JSON.stringify({reply:'Вижу корзину, всё верно!',escalate:false,reason:'ok'})];u.raw=JSON.stringify({reply:'Фото до меня не дошло, пришлите обычным фото',escalate:false,reason:'ok'});
 await igDmReply(u.env);assert.equal(u.sent.length,0,JSON.stringify(u.sent));assert.match(u.context,/не открылось/);
 const r=fixture();r.t=old;r.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:old}];r.freshAttachments='unsupported';
 r.raw=JSON.stringify({reply:'У меня почему-то не открывается картинка) Пришлёте её ещё раз одним фото?',escalate:false,reason:'ok'});
 await igDmReply(r.env);assert.equal(r.sent.length,1);
 // The Owner wrote what is on the photo: Diana answers at once and treats it as seen.
 const n=fixture();n.history=[{id:'blank',direction:'in',text:null,attachments_json:null,created_at:n.t}];n.freshAttachments='unsupported';
 n.states.set('ig_photo_note:'+n.cid,JSON.stringify({at:n.t,text:'скрин заказа TERMO'}));
 await igDmReply(n.env);assert.equal(n.sent.length,1);assert.match(n.context,/Владелец посмотрел/);
});
test.skip('after the order screenshot comes the scenario, not the video (anastasiiyaa___, Owner 2026-10-18) — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const paidAt=new Date(Date.now()-3_600_000).toISOString();
 const v=fixture();v.creator={id:'creator'};v.payouts=[{amount_minor:67100,status:'paid',konsol_payment_id:'k',paid_at:paidAt,payout_date:'2026-10-18'}];
 v.history=[{direction:'out',text:'Перевела 671 ₽ по СБП.',created_at:paidAt},{direction:'in',text:null,attachments_json:'[{"image_data":{"url":"https://lookaside.fbsbx.com/x"}}]',created_at:v.t}];
 v.raws=[JSON.stringify({reply:'Заказ вижу, отлично! Как заберёте с ПВЗ, снимите ролик и пришлите ссылку, пожалуйста.',escalate:false,reason:'ok'})];
 v.raw=JSON.stringify({reply:'Заказ вижу, спасибо) Есть своя идея ролика? Если нет, пришлю сценарии на выбор.',escalate:false,reason:'ok'});
 await igDmReply(v.env);
 assert.match(v.context,/сценария ещё нет/);assert.equal(v.sent.length,1);assert.match(String(v.sent[0][2]),/идея/);
});
test('«заказала» after the payment counts as the order, scenario comes next (Owner 2026-10-18)',async()=>{
 const paidAt=new Date(Date.now()-3_600_000).toISOString();
 const v=fixture();v.creator={id:'creator'};v.payouts=[{amount_minor:62000,status:'paid',konsol_payment_id:'k',paid_at:paidAt,payout_date:'2026-10-18'}];
 v.history=[{direction:'out',text:'Перевела 620 ₽ по СБП.',created_at:paidAt},{direction:'in',text:'Здравствуйте, оплата пришла, заказала.',created_at:v.t}];
 v.raw=JSON.stringify({reply:'Спасибо) Есть своя идея ролика? Если нет, пришлю сценарии на выбор.',escalate:false,reason:'ok'});
 await igDmReply(v.env);assert.match(v.context,/сценария ещё нет/);assert.equal(v.sent.length,1);
});
test('no second model judges Diana after she writes (Owner 2026-10-19, «ERP служит тебе»)',async()=>{
 const a=fixture();a.history=[{direction:'in',text:'Можно артикул',created_at:a.t}];
 a.raw=JSON.stringify({reply:'Лучше через поиск, так ваша покупка поможет нашей карточке)',escalate:false,reason:'ok'});
 a.voiceVerdicts=['{"ok":false,"why":"холодно"}','{"ok":false,"why":"холодно"}'];
 await igDmReply(a.env);assert.equal(a.sent.length,1);assert.ok(!a.voiceCalls);
});
const good = JSON.stringify({reply:'Получила, проверяю!',escalate:false,reason:'ok'});
function fixture() {
  const t = new Date(Date.now()-300_000).toISOString(), cid='conversation', states=new Map(), sent=[], notices=[], systems=[], sqls=[];
  const f = { t,cid,states,sent,notices,systems,sqls,live:true,raw:good,failBatch:false,
    async generate(messages) { systems.push(messages[0].content); f.context=messages[1].content; if(f.providerError) throw Error('provider'); return {text:f.raws?.length?f.raws.shift():f.raw}; },
    async notify(){notices.push(true);return true;}, async ask(text,buttons){notices.push({text,buttons});return 77;},
    async send(...args){sent.push(args);if(args[3]?.imageUrl)(f.cardUrls??=[]).push(args[3].imageUrl);return f.sendResults?.length?f.sendResults.shift():f.sendError?{ok:false,delivery:'not_sent',error:'send rejected'}:{ok:true,messageId:'mid-'+sent.length};}, async cards(_e,_h,urls){f.cardUrls=urls;return urls.length;}
  };
  f.env={DB:{prepare(sql){let p=[];sqls.push(sql);const st={bind(...v){p=v;return st;},async all(){
    if(sql.includes("json_extract(value,'$.conversationId')=?1"))return {results:[...states].filter(([key,value])=>key.startsWith('ig_reply_delivery:')&&JSON.parse(value).conversationId===p[0]).map(([,value])=>({value}))};
    if(sql.includes("key LIKE 'ig_reply_delivery:%'"))return {results:[...states].filter(([key,value])=>key.startsWith('ig_reply_delivery:')&&!JSON.parse(value).acknowledgedAt&&JSON.parse(value).status!=='superseded').map(([key,value])=>({key,value}))};
    if(sql.includes('WITH last')) return {results:f.noWaiting?[]:[{cid,t:f.waitingAt??t,h:'tester'}]};
    if(sql.includes('SELECT id, direction'))return {results:[...(f.history??[{direction:'in',text:'Подскажите',created_at:t}])].sort((a,b)=>b.created_at.localeCompare(a.created_at))};
    if(sql.includes('SELECT amount_minor'))return {results:f.payouts??[]};
    if(sql.includes('SELECT id FROM ugc_payouts'))return {results:f.openPayouts??[]};
    if(sql.includes('FROM ozon_sku_map'))return {results:f.articles??[]};
    if(sql.includes('SELECT text FROM ugc_ig_messages'))return {results:[{text:f.lastText??'Подскажите'}]};
    throw Error('unexpected all '+sql);
  },async first(){
    if(sql.includes('MAX(created_at)'))return {t:f.latestIncoming??f.t};
    if(sql.includes('SELECT value'))return states.has(p[0])?{value:states.get(p[0])}:null;
    if(sql.includes('SELECT lifecycle_stage,updated_at'))return f.creator?{...f.creator}:null;
    if(sql.includes('SELECT c.id'))return f.creator?{...f.creator}:null;
    if(sql.includes('SELECT creator_id'))return f.newCreator ? null : {creator_id:'creator',id:'profile'};
    if(sql.includes('COUNT(*) n'))return {n:0};
    if(sql.includes('SELECT p.amount_minor'))return f.paid??null;
    throw Error('unexpected first '+sql);
  },async run(){if(sql.includes('INSERT INTO crm_sync_state')) {
    if(f.markError&&p[0]==='ig_reply:'+cid)throw Error('handled marker unavailable');
    if(!sql.includes('DO NOTHING')||!states.has(p[0]))states.set(p[0],p[1]);
  }else if(sql.includes('UPDATE crm_sync_state')){
    if(states.get(p[0])!==p[3])return {success:true,meta:{changes:0}};
    states.set(p[0],p[1]);
  }else if(sql.includes('DELETE FROM crm_sync_state'))states.delete(p[0]);else if(sql.includes("lifecycle_stage='creation'")){
    if(f.completionStageError)throw Error('completion stage unavailable');
    if(f.manualAtCompletion){f.creator.lifecycle_stage=f.manualAtCompletion;f.creator.updated_at=Date.now()+1;}
    if((f.creator.lifecycle_stage??null)!==p[2]||(f.creator.updated_at??null)!==p[3])return {success:true,meta:{changes:0}};
    (f.stageWrites??=[]).push({stage:'creation',expected:p[2]});f.creator.lifecycle_stage='creation';f.creator.updated_at=p[1];
  }else if(sql.includes('UPDATE ugc_creators')){
    if(f.stageError)throw Error('stage database write');
    if(f.concurrentStage){f.creator.lifecycle_stage=f.concurrentStage;f.creator.updated_at=Date.now();}
    if((f.creator.lifecycle_stage??null)!==p[3]||(f.creator.updated_at??null)!==p[4])return {success:true,meta:{changes:0}};
    (f.stageWrites??=[]).push({stage:p[1],expected:p[3]});f.creator.lifecycle_stage=p[1];f.creator.updated_at=p[2];
  }else if(sql.includes('UPDATE ugc_payouts')){(f.heldPayouts??=[]).push(p[0]);}else throw Error('unexpected run '+sql);return {success:true,meta:{changes:1}};}};return st;},async batch(){if(f.failBatch)throw Error('database');return [];}}};
  globalThis.__ugcTest=f; return f;
}
function incident(f){return JSON.parse(f.states.get('ig_reply_escalated:'+f.cid));}
function handled(f){return f.states.get('ig_reply:'+f.cid);}
test('broken JSON stays pending, valid retry sends once and clears incident',async()=>{
 const f=fixture();f.raw='{';await igDmReply(f.env);assert.equal(handled(f),undefined);assert.equal(incident(f).status,'retry');assert.equal(f.sent.length,0);
 f.raw=good;const s=incident(f);s.next_retry_at=0;f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify(s));await igDmReply(f.env);
 assert.equal(f.sent.length,1);assert.equal(handled(f),f.t);assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);await igDmReply(f.env);assert.equal(f.sent.length,1);
});
test('three technical failures require review and notify once',async()=>{
 const f=fixture();f.raw='broken';for(let n=0;n<3;n++){if(n){const s=incident(f);s.next_retry_at=0;f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify(s));}await igDmReply(f.env);}
 assert.equal(incident(f).status,'retry');assert.equal(incident(f).attempts,3);assert.ok(incident(f).next_retry_at-Date.now()>50*60_000);assert.match(incident(f).reason,/^unparsable: broken/);assert.equal(handled(f),undefined);assert.equal(f.notices.length,0);
 await igDmReply(f.env);assert.equal(f.notices.length,0);assert.equal(f.systems.length,6);
});
test('business review remains open without sending or retrying',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:null,escalate:true,reason:'спор о старой оплате'});await igDmReply(f.env);await igDmReply(f.env);
 assert.equal(incident(f).kind,'business');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);assert.equal(f.notices.length,0);
});
test('a third technical failure remains an error when escalated; business review is not an error',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:null,escalate:true,reason:'image_verdict_requires_clarification'});
 let result;
 for(let n=0;n<3;n++){
  if(n){const s=incident(f);s.next_retry_at=0;f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify(s));}
  result=await igDmReply(f.env);
 }
 assert.equal(incident(f).kind,'stuck');assert.equal(result.escalated,1);assert.equal(result.errors,1);
 const g=fixture();g.raw=JSON.stringify({reply:null,escalate:true,reason:'спор о старой оплате'});
 const business=await igDmReply(g.env);assert.equal(business.escalated,1);assert.equal(business.errors,0);
});
test('only a return or money-back question goes to Telegram, with answer buttons (Owner 2026-10-17)',async()=>{
 const f=fixture();f.lastText='Если так то я возврат сделаю и отправлю обратно деньги';f.paid={amount_minor:76400,payout_date:'2026-10-17',first_name:'Соня'};
 f.history=[{direction:'in',text:f.lastText,created_at:f.t}];await igDmReply(f.env);await igDmReply(f.env);
 assert.equal(f.sent.length,0);assert.equal(f.notices.length,1);assert.deepEqual(f.notices[0].buttons,['Не возвращать','Вернуть деньги','Напишу сам']);
 assert.match(f.notices[0].text,/Соня, возвращать ничего не нужно\./);assert.match(f.notices[0].text,/764 ₽/);assert.ok(f.states.has('ig_hard:77'));
});
test('payout database failure sends no acknowledgement and is not handled',async()=>{
 const f=fixture();f.failBatch=true;f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:900,phone:'+79001112233',bank:'Сбер',last_name:'Тестова',first_name:'Анна'}});
 await igDmReply(f.env);assert.equal(incident(f).reason,'payout_registration_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
});
test('unknown live conversation and failed send remain pending',async()=>{
 const f=fixture();f.live=null;await igDmReply(f.env);assert.equal(incident(f).reason,'conversation_check_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
 const g=fixture();g.sendError=true;await igDmReply(g.env);assert.match(incident(g).reason,/^send_failed:/);assert.equal(handled(g),undefined);
});
test('provider outage remains pending',async()=>{const f=fixture();f.providerError=true;await igDmReply(f.env);assert.match(incident(f).reason,/^provider_error/);assert.equal(incident(f).status,'retry');assert.equal(handled(f),undefined);});
test('silence only after a closing reply; a real message is never closed unseen (Owner 2026-10-21)',async()=>{
 const f=fixture();f.history=[{direction:'in',text:'Хорошо',created_at:f.t}];f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);assert.equal(handled(f),f.t);
 const h=fixture();h.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(h.env);assert.notEqual(handled(h),h.t);assert.equal(h.systems.length,2);
 const g=fixture();g.live=false;await igDmReply(g.env);assert.equal(handled(g),g.t);assert.equal(g.sent.length,0);
});
test('rama closing acknowledgement is handled before generation even when the writer would reply', async()=>{
 for (const text of ['Хорошо', 'Хорошо, спасибо большое ❤️', 'И вам удачи! Спасибо!']) {
  const f=fixture();
  f.history=[{direction:'in',text,attachments_json:'[]',created_at:f.t},{direction:'out',text:'Как будет готов, пришлите ссылку.',created_at:new Date(Date.parse(f.t)-60_000).toISOString()}];
  f.raw=JSON.stringify({reply:'Ждём ролик!',escalate:false});
  const result=await igDmReply(f.env);
  assert.equal(handled(f),f.t);assert.equal(f.systems.length,0);assert.equal(f.contextReady,undefined);
  assert.equal(f.sent.length,0);assert.deepEqual(result,{replied:0,escalated:0,errors:0});
  await igDmReply(f.env);assert.equal(f.sent.length,0);
 }
});
test('closing skip preserves questions, requests, media, progress and answers to our question', async()=>{
 const cases=[
  {text:'Хорошо?'},
  {text:'Хорошо, а когда перевод?'},
  {text:'Спасибо, пришлите артикул'},
  {text:'Хорошо, завтра выложу ❤️'},
  {text:'Ролик готов'},
  {text:'Спасибо, деньги пришли'},
  {text:'Нет, спасибо'},
  {text:'Хорошо',attachments_json:'[{"image_data":{"url":"https://lookaside.fbsbx.com/photo"}}]'},
  {text:'Хорошо',previous:'Вы согласны на этот вариант?'},
  {text:'Хорошо',noPrevious:true},
 ];
 for(const c of cases){
  const f=fixture();f.history=[{direction:'in',text:c.text,attachments_json:c.attachments_json??'[]',created_at:f.t}];
  if(!c.noPrevious)f.history.push({direction:'out',text:c.previous??'Пришлите ссылку, когда выложите.',created_at:new Date(Date.parse(f.t)-60_000).toISOString()});
  await igDmReply(f.env);assert.equal(f.systems.length,1,JSON.stringify(c));assert.equal(f.sent.length,1,JSON.stringify(c));
 }
 // A trailing courtesy must not hide a real request in the same incoming burst.
 const f=fixture();f.history=[{direction:'in',text:'Спасибо',created_at:f.t},{direction:'in',text:'Пришлите артикул',created_at:new Date(Date.parse(f.t)-1000).toISOString()},{direction:'out',text:'Посмотрите товар в поиске.',created_at:new Date(Date.parse(f.t)-60_000).toISOString()}];
 await igDmReply(f.env);assert.equal(f.systems.length,1);assert.equal(f.sent.length,1);
 const q=fixture();q.history=[{direction:'in',text:'Хорошо',created_at:q.t},{direction:'out',text:'Ждём вашего ответа.',created_at:new Date(Date.parse(q.t)-60_000).toISOString()},{direction:'out',text:'Вам подходит этот вариант?',created_at:new Date(Date.parse(q.t)-62_000).toISOString()}];
 await igDmReply(q.env);assert.equal(q.systems.length,1);assert.equal(q.sent.length,1);
 const silent=fixture();silent.history=[{direction:'in',text:'Хорошо?',created_at:silent.t}];silent.raw=JSON.stringify({reply:null,escalate:false});
 await igDmReply(silent.env);assert.equal(handled(silent),undefined);assert.equal(silent.systems.length,2);assert.equal(incident(silent).status,'needs_review');
});
test('agreement and good wishes close without a false Owner escalation', async()=>{
 for (const text of ['Отлично , тогда договорились 🤝', 'И вам удачи ! Спасибо!']) {
  const f=fixture();f.history=[{direction:'in',text,created_at:f.t}];f.raw=JSON.stringify({reply:null,escalate:false});
  await igDmReply(f.env);assert.equal(handled(f),f.t);assert.equal(f.sent.length,0);assert.equal(f.systems.length,1);
 }
});
function orderFixture(stage='silent') {
 const f=fixture();const paidAt=new Date(Date.parse(f.t)-180_000).toISOString();
 f.creator={id:'creator',lifecycle_stage:stage,updated_at:Date.parse(f.t)-120_000};
 f.payouts=[{status:'paid',konsol_payment_id:'payment',paid_at:paidAt,amount_minor:38100,payout_date:'2026-10-22'}];
 f.history=[{id:'order-image',direction:'in',text:'',attachments_json:'[{"image_data":{"url":"https://lookaside.fbsbx.com/order"}}]',created_at:f.t},{direction:'out',text:'Пришлите скрин заказа.',created_at:new Date(Date.parse(f.t)-60_000).toISOString()}];
 f.screenshots=[{mediaType:'image/png',data:'fixture'}];
 f.imageCheck={status:'unknown',reasons:['seller_unknown','amount_no'],checks:[{kind:'order',product:'yes',seller:'unknown',amount:'no',label:`Скриншот из входящего сообщения ${f.t}, вложение 1.`}]};
 return f;
}
test('Asiya verified new order reactivates silent before sending and also with reply=null',async()=>{
 const f=orderFixture();f.raw=JSON.stringify({reply:null,escalate:false});
 await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,'ordered');assert.equal(f.sent.length,0);
 const g=orderFixture();g.sendError=true;await igDmReply(g.env);assert.equal(g.creator.lifecycle_stage,'ordered');assert.match(incident(g).reason,/^send_failed:/);
 const old=orderFixture();old.creator.updated_at=Date.parse(old.t)+1000;await igDmReply(old.env);assert.equal(old.creator.lifecycle_stage,'silent');
 const unknown=orderFixture();unknown.imageCheck.checks[0].kind='basket';await igDmReply(unknown.env);assert.equal(unknown.creator.lifecycle_stage,'silent');
});
test('explicit refusal updates stage and holds payout even without a reply, preserving protected decisions',async()=>{
 for(const stage of ['replied','silent','owner','rival','claim','unfit','fee','gold']){
  const f=fixture();f.creator={id:'creator',lifecycle_stage:stage,updated_at:1};f.openPayouts=[{id:'pending'}];
  f.history=[{direction:'in',text:'Нет, спасибо',created_at:f.t}];f.raw=JSON.stringify({reply:null,escalate:false,refused:true});
  await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,['replied','silent'].includes(stage)?'refused':stage);assert.deepEqual(f.heldPayouts,['pending']);assert.equal(f.sent.length,0);
 }
});
test('factual stages preserve protected statuses, forward progress and concurrent manual writes',async()=>{
 for(const stage of ['owner','rival','refused','gold','posted','creation']){const f=orderFixture(stage);await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,stage);}
 const race=orderFixture();race.concurrentStage='owner';await igDmReply(race.env);assert.equal(race.creator.lifecycle_stage,'owner');assert.equal(race.stageWrites,undefined);
 const courtesy=orderFixture();courtesy.history[0].text='Хорошо';courtesy.history[0].attachments_json='[]';await igDmReply(courtesy.env);assert.equal(courtesy.creator.lifecycle_stage,'silent');assert.equal(courtesy.sent.length,0);
 const oldLink=fixture();oldLink.creator={id:'creator',lifecycle_stage:'silent',updated_at:Date.parse(oldLink.t)-120_000};oldLink.history=[{direction:'in',text:'Подскажите',created_at:oldLink.t},{direction:'out',text:'Получили ссылку.',created_at:new Date(Date.parse(oldLink.t)-200_000).toISOString()},{direction:'in',text:'https://www.instagram.com/reel/OLDREEL123/',created_at:new Date(Date.parse(oldLink.t)-300_000).toISOString()}];await igDmReply(oldLink.env);assert.equal(oldLink.creator.lifecycle_stage,'silent');
});
test('stage write failure is technical and occurs before delivery; retry sends only once',async()=>{
 const f=orderFixture();f.stageError=true;const failed=await igDmReply(f.env);
 assert.equal(failed.errors,1);assert.equal(f.sent.length,0);assert.equal(handled(f),undefined);assert.equal(incident(f).kind,'technical');assert.equal(incident(f).reason,'creator_stage_update_failed');
 f.stageError=false;const s=incident(f);s.next_retry_at=0;f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify(s));
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.equal(handled(f),f.t);await igDmReply(f.env);assert.equal(f.sent.length,1);
});
test('creation requires an already delivered scenario or current own idea, never an unsent scenario draft',async()=>{
 const draft=orderFixture('paid');draft.raw=JSON.stringify({reply:'Вот сценарии, выберите вариант.',escalate:false,send_cards:true});draft.sendError=true;await igDmReply(draft.env);assert.equal(draft.creator.lifecycle_stage,'ordered');
 const idea=orderFixture();const orderAt=idea.t;idea.history.unshift({direction:'in',text:'Есть своя идея',created_at:new Date(Date.parse(orderAt)+60_000).toISOString()},{direction:'out',text:'Есть своя идея для ролика?',created_at:new Date(Date.parse(orderAt)+30_000).toISOString()});await igDmReply(idea.env);assert.equal(idea.creator.lifecycle_stage,'creation');
});
test('complete requisites survive a silent response and a following empty reaction', async()=>{
 const f=fixture();f.history=[{direction:'in',text:'Сумма 480 руб, +79001112233, Сбер, Анна',created_at:f.t},{id:'reaction',direction:'in',text:null,attachments_json:null,created_at:f.t}];f.freshAttachments='[]';
 f.raw=JSON.stringify({reply:null,escalate:false,requisites:{amount_rub:480,phone:'+79001112233',bank:'Сбер',first_name:'Анна'}});
 await igDmReply(f.env);assert.ok(f.sqls.some(s=>s.includes('INSERT INTO ugc_payouts')));assert.equal(handled(f),f.t);assert.equal(f.sent.length,0);assert.equal(f.systems.length,1);
 const g=fixture();g.failBatch=true;g.raw=f.raw;await igDmReply(g.env);
 assert.equal(handled(g),undefined);assert.equal(incident(g).reason,'payout_registration_failed');assert.equal(g.sent.length,0);
});
test('runtime appends the current menu and sends exactly four cards',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:40000,status:'paid',konsol_payment_id:'k1',payout_date:'2026-10-17',paid_at:new Date(Date.parse(f.t)-3_600_000).toISOString()}];
 f.history=[{id:'ord',direction:'in',text:'Вот скрин',attachments_json:'[{"image_data":{"url":"https://lookaside.fbsbx.com/x"}}]',created_at:f.t}];f.screenshots=[{mediaType:'image/png',data:'x'}];f.raw=JSON.stringify({reply:'Вот четыре сценария — какой вам ближе?',escalate:false,send_cards:true});await igDmReply(f.env);
 assert.equal(f.cardUrls.length,4);assert.match(f.cardUrls[2],/261017e\/card3/);assert.match(f.systems[0],/ТОЛЬКО ЧЕТЫРЕ/);
 assert.match(f.sqls.find(s=>s.includes('WITH last')),/m.created_at >= \?1/);
});
test.skip('an older paid basket does not permit saying the new basket is paid — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:90000,status:'awaiting_approval',payout_date:'2026-10-17'},{amount_minor:75800,status:'paid',konsol_payment_id:'old',payout_date:'2026-10-16'}];
 f.raw=JSON.stringify({reply:'Перевели 900 ₽ — дошло?',escalate:false});await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'claims money sent, not paid in ERP');
});

test('context failure never calls the writer, sends, or marks handled', async()=>{
 const f=fixture();f.contextError=true;await igDmReply(f.env);
 assert.equal(f.systems.length,0);assert.equal(f.sent.length,0);assert.equal(handled(f),undefined);
 assert.equal(incident(f).reason,'diana_context_unavailable');assert.equal(incident(f).status,'retry');
});
test.skip('JEV image outage never calls the writer or sends a stock response — retired: Owner 2026-10-20, the photo is read by Sonnet and a failed check never stops Diana', async()=>{
 const f=fixture();f.screenshots=[{mediaType:'image/png',data:'fixture'}];f.jevImageError=true;
 await igDmReply(f.env);assert.equal(f.systems.length,0);assert.equal(f.sent.length,0);
 assert.equal(incident(f).reason,'diana_image_check_unavailable');
});
test('an uncertain seller reaches Diana for clarification without a new payout', async()=>{
 const f=fixture();f.screenshots=[{mediaType:'image/png',data:'fixture'}];f.imageCheck={status:'unknown',reasons:['seller_unknown'],checks:[]};
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.match(f.systems[0],/seller_unknown/);
 assert.ok(!f.sqls.some(s=>s.includes('INSERT INTO ugc_payouts')));
});
test('requisites → brown button at once even when the image is unsure; the doubt is written for the Owner (Owner 2026-10-19)', async()=>{
 const f=fixture();f.screenshots=[{mediaType:'image/png',data:'fixture'}];f.imageCheck={status:'unknown',reasons:['seller_unknown'],checks:[]};
 f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'Сбер',last_name:'Тестова',first_name:'Анна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0);
 assert.ok(f.sqls.some(s=>s.includes('INSERT INTO ugc_payouts')));
});

test.skip('a registry-only paid row is described as unconfirmed, never unpaid or executed — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:90000,status:'paid',payout_date:'2026-10-17',konsol_payment_id:null}];
 f.raw=JSON.stringify({reply:'Перевели 900 ₽ — дошло?',escalate:false});await igDmReply(f.env);
 assert.match(f.context,/исполнение перевода не подтверждено/);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'claims money sent, not paid in ERP');
});

test('creator registration failure stays pending without any acknowledgement',async()=>{
 const f=fixture();f.newCreator=true;f.failBatch=true;await igDmReply(f.env);assert.equal(incident(f).reason,'creator_registration_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
});

test('screenshots are passed as images to vision, not just attachment text',async()=>{
 const f=fixture();f.screenshots=[{mediaType:'image/png',data:'fixture',label:'Скриншот 1'}];
 await igDmReply(f.env);assert.equal(f.visionCalled,true);assert.equal(f.sent.length,1);
});
test('an unavailable screenshot stays open and sends no blind acknowledgement',async()=>{
 const f=fixture();f.imageError=true;await igDmReply(f.env);assert.equal(incident(f).reason,'current_image_unavailable');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);assert.equal(f.systems.length,0);
});

test('unavailable older image does not block complete current text requisites',async()=>{
 const f=fixture();f.unreadable=1;f.history=[{direction:'in',text:'89990001122 Тестова Анна Ивановна сбер Итого 627р',created_at:f.t},{direction:'out',text:'Пришлите реквизиты',created_at:f.t}];
 f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'сбер',last_name:'Тестова',first_name:'Анна',patronymic:'Ивановна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0,'no requisites ack (Owner 2026-10-18)');assert.equal(handled(f),f.t);
});
test.skip('an expired picture plus incomplete text cannot produce a fabricated payout — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const f=fixture();f.unreadable=1;f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'сбер',last_name:'Тестова',first_name:'Анна',patronymic:'Ивановна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'image_read_failed');assert.equal(handled(f),undefined);
});

test('payment wording leaves at once, no rewrite loop (Owner 2026-10-20)',async()=>{
 const f=fixture();f.raws=[JSON.stringify({reply:'Мы оплачиваем пасту, вы снимаете ролик.',escalate:false}),good];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.equal(f.systems.length,1);assert.equal(handled(f),f.t);
});

test.skip('a surname initial taken from a patronymic is never registered (Owner 2026-10-18, irina__sayapina) — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const f=fixture();f.history=[{direction:'in',text:'89158785710 / Сбербанк / Ирина Алексеевна',created_at:f.t}];
 const req=JSON.stringify({reply:'Реквизиты получили, проверяю!',escalate:false,requisites:{amount_rub:345,phone:'89158785710',bank:'Сбербанк',last_name:'А',first_name:'Ирина',product:'TERMO'}});
 f.raws=[req,JSON.stringify({reply:'Ирина, подскажите, пожалуйста, первую букву фамилии.',escalate:false})];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/первую букву фамилии/);assert.match(f.systems[1],/нет первой буквы фамилии/);
});

test.skip('requisites wait for our Ozon article; a named article of ours lets them through (Owner 2026-10-18) — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const req=JSON.stringify({reply:'Реквизиты получили, проверяю!',escalate:false,requisites:{amount_rub:395,phone:'89640011206',bank:'Озон банк',last_name:'Курабекова',first_name:'Зайнаб',product:'TERMO'}});
 const ask=JSON.stringify({reply:'Подскажите, пожалуйста, артикул пасты на Ozon?',escalate:false});
 const f=fixture();f.articles=[{a:'3497962138',n:'TERMO 39'}];f.history=[{direction:'in',text:'Озон банк Зайнаб Курабекова 89640011206',created_at:f.t}];f.raws=[req,ask];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/артикул/);assert.match(f.systems[1],/артикул нашей карточки/);assert.match(f.systems[0],/3497962138 TERMO 39/);
 const g=fixture();g.articles=[{a:'3497962138',n:'TERMO 39'}];g.history=[{direction:'in',text:'артикул 3497962138, Озон банк Зайнаб Курабекова 89640011206',created_at:g.t}];g.raw=req;g.failBatch=true;
 await igDmReply(g.env);assert.equal(incident(g).reason,'payout_registration_failed');
});

test('no article needed when JEV recognises our paste at the usual price (Owner 2026-10-18)',()=>{
 const yes={status:'yes',checks:[{kind:'basket',product:'yes',seller:'unknown',amount:'yes'}]};
 const band={low:26600,high:49400};
 assert.equal(jevSure(yes,{amount_minor:39500,product:'TERMO'},band),true);
 assert.equal(jevSure(yes,{amount_minor:15000,product:'TERMO'},band),false);
 assert.equal(jevSure({...yes,status:'unknown'},{amount_minor:39500,product:'TERMO'},band),false);
 assert.equal(jevSure(yes,{amount_minor:39500,product:'TERMO'},null),false);
});

test('a full surname written in her own words is taken (sammaya_89191323 2026-10-18)', () => {
  assert.equal(surnameWritten('С', '79655145756 Сбер 700₽ За пасту термо Нина Сосновая', 'Нина'), 'Сосновая');
  assert.equal(surnameWritten('А', 'Ирина Алексеевна', 'Ирина'), null);
  assert.equal(surnameWritten('С', 'Сбер Сосновая Смирнова', 'Нина'), null);
});

test.skip('the ladder: no scenario before the order screenshot (Owner 2026-10-18) — veto retired by Owner 2026-10-20 «убери их»',async()=>{
 const f=fixture();f.raws=[JSON.stringify({reply:'Оформляйте заказ! А пока выберите сценарий — вот карточки.',escalate:false,send_cards:true}),JSON.stringify({reply:'Вот четыре сценария, выберите номер.',escalate:false,send_cards:true})];
 await igDmReply(f.env);assert.equal(f.cardUrls?.length??0,0);assert.equal(f.sent.length,0);assert.match(f.context,/СТУПЕНЬ/);
});

test('partial text failure is not handled; archived outgoing does not lose the unsent suffix',async()=>{
 const f=fixture();f.raw=JSON.stringify({replies:['Первое сообщение','Второе сообщение','Третье сообщение'],escalate:false});
 f.sendResults=[{ok:true,messageId:'first-receipt'},{ok:false,delivery:'not_sent',error:'rate limited'}];
 const first=await igDmReply(f.env);assert.equal(first.replied,0);assert.equal(first.errors,1);assert.equal(handled(f),undefined);
 assert.equal(f.sent.length,2);f.noWaiting=true;
 const resumed=await igDmReply(f.env);assert.equal(resumed.replied,1);assert.equal(resumed.errors,0);assert.equal(handled(f),f.t);
 assert.deepEqual(f.sent.map(args=>args[2]),['Первое сообщение','Второе сообщение','Второе сообщение','Третье сообщение']);
 assert.equal(f.systems.length,1);
});
test('partial cards are not handled and resume only rejected and remaining cards',async()=>{
 const f=scenarioFixture();
 f.sendResults=[{ok:true,messageId:'text'},{ok:true,messageId:'card1'},{ok:false,delivery:'not_sent',error:'rate limited'}];
 const first=await igDmReply(f.env);assert.equal(first.replied,0);assert.equal(first.errors,1);assert.equal(handled(f),undefined);
 const sentCard1=f.sent[1][3].imageUrl;f.noWaiting=true;
 const resumed=await igDmReply(f.env);assert.equal(resumed.replied,1);assert.equal(handled(f),f.t);
 assert.equal(f.sent.filter(args=>args[3]?.imageUrl===sentCard1).length,1);assert.equal(f.sent.length,6);
});
test('successful delivery with failed handled marker retries only acknowledgement',async()=>{
 const f=fixture();f.markError=true;
 await assert.rejects(igDmReply(f.env),/handled marker/);assert.equal(f.sent.length,1);assert.equal(handled(f),undefined);
 f.markError=false;f.noWaiting=true;
 const resumed=await igDmReply(f.env);assert.equal(resumed.replied,1);assert.equal(f.sent.length,1);assert.equal(handled(f),f.t);
});
test('ambiguous send is visible and never regenerated or automatically repeated',async()=>{
 const f=fixture();f.sendResults=[{ok:false,delivery:'unknown',error:'timeout'}];
 const first=await igDmReply(f.env);assert.equal(first.errors,1);assert.equal(first.escalated,1);assert.equal(handled(f),undefined);
 const again=await igDmReply(f.env);assert.equal(again.errors,1);assert.equal(f.sent.length,1);assert.equal(f.systems.length,1);
});
test('closed-window partial text queues only unsent suffix and does not claim a complete reply',async()=>{
 const f=fixture();f.raw=JSON.stringify({replies:['Первое сообщение','Второе сообщение'],escalate:false});
 f.sendResults=[{ok:true,messageId:'first'},{ok:false,delivery:'not_sent',error:'Outside allowed window'}];
 const first=await igDmReply(f.env);assert.equal(first.replied,0);assert.equal(first.errors,0);assert.equal(handled(f),f.t);
 const queued=JSON.parse(f.states.get('browser_queue:tester'));assert.equal(queued.items.length,1);assert.equal(queued.items[0].text,'Второе сообщение');
 await igDmReply(f.env);assert.equal(f.sent.length,2);assert.equal(JSON.parse(f.states.get('browser_queue:tester')).items.length,1);
});

function scenarioFixture(){
 const f=fixture();const paidAt=new Date(Date.parse(f.t)-3_600_000).toISOString();
 f.creator={id:'creator',lifecycle_stage:'paid',updated_at:Date.parse(paidAt)};
 f.payouts=[{amount_minor:62000,status:'paid',konsol_payment_id:'k',paid_at:paidAt,payout_date:'2026-10-23'}];
 f.history=[{direction:'out',text:'Перевела 620 ₽ по СБП.',created_at:paidAt},{direction:'in',text:'Здравствуйте, заказала.',created_at:f.t}];
 f.raw=JSON.stringify({reply:'Вот четыре сценария на выбор',send_cards:true,escalate:false});return f;
}
test('verified order advances to creation only after all four card receipts',async()=>{
 const f=scenarioFixture();f.sendResults=[{ok:true,messageId:'text'},{ok:true,messageId:'card1'},{ok:false,delivery:'not_sent',error:'rate limited'}];
 await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,'ordered');assert.equal(handled(f),undefined);
 f.noWaiting=true;await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,'creation');assert.equal(handled(f),f.t);
 assert.deepEqual(f.stageWrites.map(x=>x.stage),['ordered','creation']);
});
test('failed completion stage write retries status acknowledgement without any resend',async()=>{
 const f=scenarioFixture();f.completionStageError=true;
 await assert.rejects(igDmReply(f.env),/completion stage/);assert.equal(f.sent.length,5);assert.equal(f.creator.lifecycle_stage,'ordered');assert.equal(handled(f),undefined);
 f.completionStageError=false;f.noWaiting=true;await igDmReply(f.env);
 assert.equal(f.sent.length,5);assert.equal(f.creator.lifecycle_stage,'creation');assert.equal(handled(f),f.t);
});
test('manual decision made after delivery plan wins over completion stage CAS',async()=>{
 const f=scenarioFixture();f.manualAtCompletion='refused';
 await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,'refused');assert.equal(handled(f),f.t);assert.equal(f.sent.length,5);
});
test('fifteen resumed delivery attempts consume the existing per-run attempt budget',async()=>{
 const f=fixture();
 for(let i=0;i<15;i++)f.states.set('ig_reply_delivery:old-'+i+':'+f.t,JSON.stringify({version:1,conversationId:'old-'+i,incomingAt:f.t,handle:'old-'+i,status:'pending',items:[{text:'remaining',status:'pending'}]}));
 await igDmReply(f.env);assert.equal(f.sent.length,15);assert.equal(f.systems.length,0);
});

test('a partial scenario superseded by new incoming stays ordered and never repeats card one',async()=>{
 const f=scenarioFixture();f.sendResults=[{ok:true,messageId:'text'},{ok:true,messageId:'card1'},{ok:false,delivery:'not_sent',error:'rate limited'}];
 await igDmReply(f.env);const sentBefore=f.sent.length;
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'out',text:'Вот четыре сценария',created_at:new Date(Date.parse(f.t)+10_000).toISOString()},
 {direction:'out',text:null,attachments_json:'[{"image_data":{"url":"card1"}}]',created_at:new Date(Date.parse(f.t)+11_000).toISOString()},
 {direction:'in',text:'А какие варианты есть?',created_at:newAt});
 const next=await igDmReply(f.env);
 assert.equal(f.creator.lifecycle_stage,'ordered');assert.equal(f.sent.length,sentBefore);
 assert.equal(next.errors,1);assert.equal(incident(f).status,'needs_review');assert.match(incident(f).reason,/scenario_delivery_incomplete/);
 assert.match(f.context,/Часть карточек/);
});
test('asking whether a creator wants scenarios is not delivery or creation evidence',async()=>{
 const f=scenarioFixture();const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'out',text:'Хотите сценарий?',created_at:new Date(Date.parse(f.t)+10_000).toISOString()},
 {direction:'in',text:'Какие варианты есть?',created_at:newAt});
 f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);
 assert.equal(f.creator.lifecycle_stage,'ordered');assert.match(f.context,/сценария ещё нет/);assert.equal(f.sent.length,0);
});
test('current explicit own idea after a verified order advances to creation without card assumptions',async()=>{
 const f=scenarioFixture();const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'in',text:'Есть своя идея ролика',created_at:newAt});
 f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);
 assert.equal(f.creator.lifecycle_stage,'creation');assert.equal(f.sent.length,0);
});
test('completed four-card receipts remain valid evidence on a later incoming message',async()=>{
 const f=scenarioFixture();await igDmReply(f.env);assert.equal(f.creator.lifecycle_stage,'creation');
 f.creator.lifecycle_stage='ordered';f.creator.updated_at=Date.parse(f.t)+20_000;
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'out',text:'Сообщение',created_at:new Date(Date.parse(f.t)+30_000).toISOString()},
 {direction:'in',text:'А что дальше?',created_at:newAt});
 f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);
 assert.equal(f.creator.lifecycle_stage,'creation');assert.equal(f.sent.length,5);
});

test('completed scenario receipts prohibit a second image set even if stage was reset to ordered',async()=>{
 const f=scenarioFixture();await igDmReply(f.env);
 assert.equal(f.cardUrls.length,4);
 f.creator.lifecycle_stage='ordered';f.creator.updated_at=Date.parse(f.t)+20_000;
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'out',text:'Выбирайте подходящую идею.',created_at:new Date(Date.parse(f.t)+30_000).toISOString()},
  {direction:'in',text:'Расскажите вашу идею подробнее',created_at:newAt});
 f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify({handle:'tester',at:newAt,kind:'technical',status:'needs_review',reason:'send_failed: scenario_resend_unverified',attempts:1,same:1}));
 f.raw=JSON.stringify({reply:'Снимите первую чистку и расскажите о своих ощущениях.',send_cards:true,escalate:false});
 const result=await igDmReply(f.env);
 assert.equal(result.replied,1);assert.equal(result.errors,0);assert.equal(f.cardUrls.length,4);
 assert.equal(f.sent.length,6);assert.equal(handled(f),newAt);assert.equal(f.creator.lifecycle_stage,'creation');
 const current=JSON.parse(f.states.get('ig_reply_delivery:'+f.cid+':'+newAt));
 assert.equal(current.items.filter(item=>item.imageUrl).length,0);
 assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);
});

test('legacy creation with archived cards continues normal video conversation without resend or new receipt claim',async()=>{
 const f=scenarioFixture();f.creator.lifecycle_stage='creation';
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 for(let i=0;i<4;i++)f.history.push({direction:'out',text:null,attachments_json:JSON.stringify([{image_data:{url:'legacy-card-'+i}}]),created_at:new Date(Date.parse(f.t)+10_000+i*1000).toISOString()});
 f.history.push({direction:'in',text:'Скоро отправлю ролик',created_at:newAt});
 f.raw=JSON.stringify({reply:'Буду ждать ссылку на ролик)',send_cards:false,escalate:false});
 const result=await igDmReply(f.env);
 assert.equal(result.errors,0);assert.equal(result.replied,1);assert.equal(f.creator.lifecycle_stage,'creation');
 assert.equal(f.sent.length,1);assert.equal(f.cardUrls?.length??0,0);assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);
 assert.match(f.context,/этап создания уже достигнут/);assert.doesNotMatch(f.context,/сценария ещё нет/);
});
test('unverified legacy card history may answer a question but cannot regenerate a full set',async()=>{
 const f=scenarioFixture();f.creator.lifecycle_stage='ordered';
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({direction:'out',text:'Вот карточки',attachments_json:'[{"image_data":{"url":"legacy-card"}}]',created_at:new Date(Date.parse(f.t)+10_000).toISOString()},
 {direction:'in',text:'Какой вариант выбрать?',created_at:newAt});
 const result=await igDmReply(f.env);
 assert.equal(result.errors,1);assert.equal(f.sent.length,0);assert.equal(f.creator.lifecycle_stage,'ordered');assert.match(incident(f).reason,/scenario_text_rewrite_required/);assert.equal(incident(f).status,'retry');
});

async function receiptedScenarioOffer(review=false){
 const f=scenarioFixture();
 f.raw=JSON.stringify({replies:['Отлично, заказ оформлен!','Есть своя идея для ролика или выбрать из наших сценариев?'],send_cards:false,escalate:false});
 await igDmReply(f.env);
 const offer=JSON.parse([...f.states].find(([key])=>key.startsWith('ig_reply_delivery:'))[1]);
 for(const [index,item] of offer.items.entries())f.history.push({id:item.messageId,direction:'out',text:item.text,created_at:new Date(Date.parse(f.t)+10_000+index*1000).toISOString()});
 const newAt=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=newAt;f.latestIncoming=newAt;
 f.history.push({id:'scenario-request',direction:'in',text:'Какие у вас сценарии?',created_at:newAt});
 f.raw=JSON.stringify({reply:'Вот четыре сценария на выбор',send_cards:true,escalate:false});
 if(review)f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify({handle:'tester',at:newAt,kind:'technical',status:'needs_review',reason:'send_failed: scenario_resend_unverified',attempts:1,same:1,notified_at:new Date().toISOString()}));
 return f;
}

test('asliada: a receipted text-only offer allows the first scenario cards once',async()=>{
 const f=await receiptedScenarioOffer();
 const result=await igDmReply(f.env);
 assert.equal(result.errors,0);assert.equal(result.replied,1);assert.equal(f.cardUrls.length,4);
 assert.equal(f.creator.lifecycle_stage,'creation');assert.equal(handled(f),f.waitingAt);
 assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);
 await igDmReply(f.env);assert.equal(f.cardUrls.length,4);assert.equal(f.sent.length,7);
});

test('asliada: the natural lane resumes the exact unsent review after proving the offer was text-only',async()=>{
 const f=await receiptedScenarioOffer(true);
 const result=await igDmReply(f.env);
 assert.equal(result.replied,1);assert.equal(result.errors,0);assert.equal(f.cardUrls.length,4);
 assert.equal(handled(f),f.waitingAt);assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);
});

test('scenario review recovery allows only text with unknown legacy attachments or mismatched receipts',async()=>{
 for(const changed of ['receipt','attachment']){
  const f=await receiptedScenarioOffer(true);
  if(changed==='receipt')f.history.find(m=>m.text?.includes('из наших сценариев')).id='unverified-other-message';
  else f.history.splice(-1,0,{id:'legacy-card',direction:'out',text:null,attachments_json:'[{"image_data":{"url":"legacy-card"}}]',created_at:new Date(Date.parse(f.t)+20_000).toISOString()});
  f.raws=[f.raw,JSON.stringify({reply:'Можно снять первую чистку у окна и рассказать, что почувствовали.',send_cards:false,escalate:false})];
  const result=await igDmReply(f.env);
  assert.equal(result.replied,1);assert.equal(f.sent.length,3);assert.equal(f.cardUrls?.length??0,0);
  assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);assert.equal(f.creator.lifecycle_stage,'ordered');
 }
});

function asiyashkaScenarioReview(){
 const f=scenarioFixture();f.creator.lifecycle_stage='posted';
 const at=new Date(Date.parse(f.t)+60_000).toISOString();f.waitingAt=at;f.latestIncoming=at;
 f.history.push({id:'own-idea-question',direction:'out',text:'Вы говорили, что есть своя идея для ролика. Расскажите?',created_at:new Date(Date.parse(f.t)+10_000).toISOString()},
  {id:'post-date',direction:'in',text:'Как приедет я тогда придумаю сразу же и потом выложу 26.10',created_at:new Date(Date.parse(at)-5000).toISOString()},
  {id:'idea-request',direction:'in',text:'Ну и можно посмотреть вашу идею на всякий случи',created_at:at});
 f.states.set('ig_reply_escalated:'+f.cid,JSON.stringify({handle:'tester',at,kind:'technical',status:'needs_review',reason:'send_failed: scenario_resend_unverified',attempts:1,same:1,notified_at:new Date().toISOString()}));
 f.raw=JSON.stringify({replies:['Отлично, ждём 26-го!','Вот четыре варианта на выбор, пришлите номер от 1 до 4.'],send_cards:true,escalate:false});
 return f;
}

test('asiyashka: posted creator asking for an idea receives text, no images or false attachment claim',async()=>{
 const f=asiyashkaScenarioReview();
 const answer='26 октября подойдёт) Можно снять первую чистку у окна: сказать «Название обещает тепло, проверяю», а после показать тубу и рассказать, что почувствовали.';
 f.raws=[f.raw,JSON.stringify({reply:answer,send_cards:false,escalate:false})];
 const result=await igDmReply(f.env);
 assert.equal(result.replied,1);assert.equal(result.errors,0);assert.equal(f.sent.length,1);assert.equal(f.sent[0][2],answer);
 assert.equal(f.cardUrls?.length??0,0);assert.equal(f.creator.lifecycle_stage,'posted');assert.equal(f.systems.length,2);
 assert.equal(handled(f),f.waitingAt);assert.equal(f.states.has('ig_reply_escalated:'+f.cid),false);
 assert.ok(f.systems[0].lastIndexOf('ДОСТАВКА В ЭТОМ ОТВЕТЕ')>f.systems[0].indexOf('Если блогер просит сценарии'));
 await igDmReply(f.env);assert.equal(f.sent.length,1);
});

test('text-only capability suppresses a mistaken image flag without blocking a safe answer or downgrading stage',async()=>{
 for(const stage of ['creation','posted','gold']){
  const f=asiyashkaScenarioReview();f.creator.lifecycle_stage=stage;
  f.raw=JSON.stringify({reply:'Договорились, ждём ваш ролик 26 октября)',send_cards:true,escalate:false});
  const result=await igDmReply(f.env);
  assert.equal(result.replied,1);assert.equal(f.cardUrls?.length??0,0);assert.equal(f.creator.lifecycle_stage,stage);assert.equal(f.systems.length,1);
 }
 const details=asiyashkaScenarioReview();details.raw=JSON.stringify({reply:'Пришлите номер телефона и банк.',send_cards:false,escalate:false});
 await igDmReply(details.env);assert.equal(details.sent.length,1);assert.equal(details.systems.length,1);
});

test('an unsupported card promise without the image flag is rewritten, and repeated unsafe text remains unsent on normal retry',async()=>{
 const f=asiyashkaScenarioReview();
 f.raws=[JSON.stringify({reply:'Карточки прикреплены, выбирайте!',send_cards:false,escalate:false}),JSON.stringify({reply:'Можно снять первую чистку и рассказать о своих ощущениях.',send_cards:false,escalate:false})];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.doesNotMatch(f.sent[0][2],/карточк/i);assert.equal(f.cardUrls?.length??0,0);
 const repeated=asiyashkaScenarioReview();const result=await igDmReply(repeated.env);
 assert.equal(result.errors,1);assert.equal(repeated.sent.length,0);assert.equal(repeated.systems.length,2);
 assert.equal(incident(repeated).status,'retry');assert.match(incident(repeated).reason,/scenario_text_rewrite_required/);
 assert.equal([...repeated.states.keys()].some(key=>key.startsWith('ig_reply_delivery:')),false);
});

test('text-only recovery never bypasses an ambiguous earlier card intent',async()=>{
 const f=asiyashkaScenarioReview();const key='ig_reply_delivery:'+f.cid+':'+f.t;
 const intent=JSON.stringify({version:1,conversationId:f.cid,incomingAt:f.t,handle:'tester',status:'ambiguous',items:[{imageUrl:'unknown-card',status:'sending'}],completion:{creatorId:'creator'}});
 f.states.set(key,intent);f.raw=JSON.stringify({reply:'Можно снять первую чистку.',send_cards:false,escalate:false});
 await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(f.systems.length,0);assert.equal(f.states.get(key),intent);assert.equal(f.creator.lifecycle_stage,'posted');
});

test('scenario review recovery does not reopen a manual decision or an ambiguous current delivery',async()=>{
 const manual=await receiptedScenarioOffer(true);manual.creator.lifecycle_stage='owner';
 const review=manual.states.get('ig_reply_escalated:'+manual.cid);
 await igDmReply(manual.env);assert.equal(manual.sent.length,2);assert.equal(manual.creator.lifecycle_stage,'owner');
 assert.equal(manual.states.get('ig_reply_escalated:'+manual.cid),review);
 const ambiguous=await receiptedScenarioOffer(true);
 const key='ig_reply_delivery:'+ambiguous.cid+':'+ambiguous.waitingAt;
 const intent=JSON.stringify({version:1,conversationId:ambiguous.cid,incomingAt:ambiguous.waitingAt,handle:'tester',status:'ambiguous',error:'delivery_interrupted_without_receipt',items:[{imageUrl:'card-unknown',status:'sending'}]});
 ambiguous.states.set(key,intent);await igDmReply(ambiguous.env);
 assert.equal(ambiguous.sent.length,2);assert.equal(ambiguous.states.get(key),intent);
 assert.equal(ambiguous.creator.lifecycle_stage,'ordered');assert.equal(incident(ambiguous).status,'needs_review');
});
