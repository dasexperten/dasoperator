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
      ? 'export const callPro=(messages)=>globalThis.__ugcTest.generate(messages); export const callVision=(messages)=>{globalThis.__ugcTest.visionCalled=true;return globalThis.__ugcTest.generate(messages)};'
      : a.path==='./diana-context.mjs' ? 'export const prepareDianaContext=async()=>{if(globalThis.__ugcTest.contextError)throw Error("context");globalThis.__ugcTest.contextReady=true;return {system:"Full Diana JEV context",imagePolicy:{},receipt:{method:"jev"}}};'
      : a.path==='./diana-image-check.mjs' ? 'export const checkDianaImages=async()=>{if(globalThis.__ugcTest.jevImageError)throw Error("JEV image");return globalThis.__ugcTest.imageCheck??{status:"yes",reasons:[],checks:[]}};'
      : a.path==='./ig-dm-attachments' ? 'export const incomingScreenshots=async()=>{if(globalThis.__ugcTest.imageError)throw Error("image");return {images:globalThis.__ugcTest.screenshots??[],unreadable:globalThis.__ugcTest.unreadable??0}};'
      : a.path==='./owner-telegram' ? 'export const sendOwnerTelegram=()=>globalThis.__ugcTest.notify(); export const sendOwnerQuestion=(_e,text,buttons)=>globalThis.__ugcTest.ask(text,buttons);'
      : 'export const refreshIgAttachments=async()=>globalThis.__ugcTest.freshAttachments??null; export const lastWordIsBlogger=()=>globalThis.__ugcTest.live; export const sendIgDirect=(...args)=>globalThis.__ugcTest.send(...args); export const sendIgCards=(...args)=>globalThis.__ugcTest.cards(...args);' }));
  }}] });
const { igDmReply } = await import(pathToFileURL(outfile));
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
 const f=fixture();f.raw=JSON.stringify({reply:'Вот четыре сценария — какой вам ближе?',escalate:false,send_cards:true});await igDmReply(f.env);
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
test('Diana cannot register a payout contrary to the JEV image verdict', async()=>{
 const f=fixture();f.screenshots=[{mediaType:'image/png',data:'fixture'}];f.imageCheck={status:'unknown',reasons:['seller_unknown'],checks:[]};
 f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'Сбер',last_name:'Тестова',first_name:'Анна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'image_verdict_requires_clarification');
 assert.ok(!f.sqls.some(s=>s.includes('INSERT INTO ugc_payouts')));
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
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.equal(handled(f),f.t);
});
test('an expired picture plus incomplete text cannot produce a fabricated payout',async()=>{
 const f=fixture();f.unreadable=1;f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:627,phone:'89990001122',bank:'сбер',last_name:'Тестова',first_name:'Анна',patronymic:'Ивановна'}});
 await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'image_read_failed');assert.equal(handled(f),undefined);
});

test('a rejected draft is rewritten at once with the reason (Owner 2026-10-18)',async()=>{
 const f=fixture();f.raws=[JSON.stringify({reply:'Сейчас переведу вам деньги!',escalate:false}),good];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.equal(f.systems.length,2);assert.match(f.systems[1],/ОТКЛОНЁН ПРОВЕРКОЙ: нельзя обещать перевод/);assert.equal(handled(f),f.t);
});

test('a surname initial taken from a patronymic is never registered (Owner 2026-10-18, irina__sayapina)',async()=>{
 const f=fixture();f.history=[{direction:'in',text:'89158785710 / Сбербанк / Ирина Алексеевна',created_at:f.t}];
 const req=JSON.stringify({reply:'Реквизиты получила, проверяю!',escalate:false,requisites:{amount_rub:345,phone:'89158785710',bank:'Сбербанк',last_name:'А',first_name:'Ирина',product:'TERMO'}});
 f.raws=[req,JSON.stringify({reply:'Ирина, подскажите, пожалуйста, первую букву фамилии.',escalate:false})];
 await igDmReply(f.env);assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/первую букву фамилии/);assert.match(f.systems[1],/нет первой буквы фамилии/);
});
