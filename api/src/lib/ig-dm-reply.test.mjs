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
test('a photo programs cannot open goes to the Owner first, never «did not arrive» (Owner 2026-10-18)',async()=>{
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
test('after the order screenshot comes the scenario, not the video (anastasiiyaa___, Owner 2026-10-18)',async()=>{
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
    async send(...args){sent.push(args);return {ok:!f.sendError};}, async cards(_e,_h,urls){f.cardUrls=urls;return urls.length;}
  };
  f.env={DB:{prepare(sql){let p=[];sqls.push(sql);const st={bind(...v){p=v;return st;},async all(){
    if(sql.includes('WITH last')) return {results:[{cid,t,h:'tester'}]};
    if(sql.includes('SELECT id, direction'))return {results:f.history??[{direction:'in',text:'Подскажите',created_at:t}]};
    if(sql.includes('SELECT amount_minor'))return {results:f.payouts??[]};
    if(sql.includes('FROM ozon_sku_map'))return {results:f.articles??[]};
    if(sql.includes('SELECT text FROM ugc_ig_messages'))return {results:[{text:f.lastText??'Подскажите'}]};
    throw Error('unexpected all '+sql);
  },async first(){
    if(sql.includes('SELECT value'))return states.has(p[0])?{value:states.get(p[0])}:null;
    if(sql.includes('SELECT c.id'))return f.creator??null;
    if(sql.includes('SELECT creator_id'))return f.newCreator ? null : {creator_id:'creator',id:'profile'};
    if(sql.includes('COUNT(*) n'))return {n:0};
    if(sql.includes('SELECT p.amount_minor'))return f.paid??null;
    throw Error('unexpected first '+sql);
  },async run(){if(sql.includes('INSERT INTO crm_sync_state')) states.set(p[0],p[1]);else if(sql.includes('DELETE FROM crm_sync_state'))states.delete(p[0]);else throw Error('unexpected run '+sql);return {success:true};}};return st;},async batch(){if(f.failBatch)throw Error('database');return [];}}};
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
 const g=fixture();g.sendError=true;await igDmReply(g.env);assert.equal(incident(g).reason,'send_failed');assert.equal(handled(g),undefined);
});
test('provider outage remains pending',async()=>{const f=fixture();f.providerError=true;await igDmReply(f.env);assert.match(incident(f).reason,/^provider_error/);assert.equal(incident(f).status,'retry');assert.equal(handled(f),undefined);});
test('safe no-answer and confirmed existing reply are handled',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);assert.equal(handled(f),f.t);
 const g=fixture();g.live=false;await igDmReply(g.env);assert.equal(handled(g),g.t);assert.equal(g.sent.length,0);
});
test('runtime appends the current menu and sends exactly four cards',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:40000,status:'paid',konsol_payment_id:'k1',payout_date:'2026-10-17',paid_at:new Date(Date.parse(f.t)-3_600_000).toISOString()}];
 f.history=[{id:'ord',direction:'in',text:'Вот скрин',attachments_json:'[{"image_data":{"url":"https://lookaside.fbsbx.com/x"}}]',created_at:f.t}];f.screenshots=[{mediaType:'image/png',data:'x'}];f.raw=JSON.stringify({reply:'Вот четыре сценария — какой вам ближе?',escalate:false,send_cards:true});await igDmReply(f.env);
 assert.equal(f.cardUrls.length,4);assert.match(f.cardUrls[2],/261017e\/card3/);assert.match(f.systems[0],/ТОЛЬКО ЧЕТЫРЕ/);
 assert.match(f.sqls.find(s=>s.includes('WITH last')),/m.created_at >= \?1/);
});
test('an older paid basket does not permit saying the new basket is paid',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:90000,status:'awaiting_approval',payout_date:'2026-10-17'},{amount_minor:75800,status:'paid',konsol_payment_id:'old',payout_date:'2026-10-16'}];
 f.raw=JSON.stringify({reply:'Перевели 900 ₽ — дошло?',escalate:false});await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'claims money sent, not paid in ERP');
});

test('context failure never calls the writer, sends, or marks handled', async()=>{
 const f=fixture();f.contextError=true;await igDmReply(f.env);
 assert.equal(f.systems.length,0);assert.equal(f.sent.length,0);assert.equal(handled(f),undefined);
 assert.equal(incident(f).reason,'diana_context_unavailable');assert.equal(incident(f).status,'retry');
});
test('JEV image outage never calls the writer or sends a stock response', async()=>{
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

test('a registry-only paid row is described as unconfirmed, never unpaid or executed',async()=>{
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
test('an expired picture plus incomplete text cannot produce a fabricated payout',async()=>{
 const f=fixture();f.unreadable=1;f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'сбер',last_name:'Тестова',first_name:'Анна',patronymic:'Ивановна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'image_read_failed');assert.equal(handled(f),undefined);
});

test('payment wording leaves at once, no rewrite loop (Owner 2026-10-20)',async()=>{
 const f=fixture();f.raws=[JSON.stringify({reply:'Мы оплачиваем пасту, вы снимаете ролик.',escalate:false}),good];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.equal(f.systems.length,1);assert.equal(handled(f),f.t);
});

test('a surname initial taken from a patronymic is never registered (Owner 2026-10-18, irina__sayapina)',async()=>{
 const f=fixture();f.history=[{direction:'in',text:'89158785710 / Сбербанк / Ирина Алексеевна',created_at:f.t}];
 const req=JSON.stringify({reply:'Реквизиты получили, проверяю!',escalate:false,requisites:{amount_rub:345,phone:'89158785710',bank:'Сбербанк',last_name:'А',first_name:'Ирина',product:'TERMO'}});
 f.raws=[req,JSON.stringify({reply:'Ирина, подскажите, пожалуйста, первую букву фамилии.',escalate:false})];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/первую букву фамилии/);assert.match(f.systems[1],/нет первой буквы фамилии/);
});

test('requisites wait for our Ozon article; a named article of ours lets them through (Owner 2026-10-18)',async()=>{
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

test('the ladder: no scenario before the order screenshot (Owner 2026-10-18)',async()=>{
 const f=fixture();f.raws=[JSON.stringify({reply:'Оформляйте заказ! А пока выберите сценарий — вот карточки.',escalate:false,send_cards:true}),JSON.stringify({reply:'Вот четыре сценария, выберите номер.',escalate:false,send_cards:true})];
 await igDmReply(f.env);assert.equal(f.cardUrls?.length??0,0);assert.equal(f.sent.length,0);assert.match(f.context,/СТУПЕНЬ/);
});
