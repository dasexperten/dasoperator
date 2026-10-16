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
    b.onResolve({filter: /^\.\/(llm|ig-dm-watch|owner-telegram)$/}, a => ({path:a.path, namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'}, a => ({contents: a.path==='./llm'
      ? 'export const callPro=(messages)=>globalThis.__ugcTest.generate(messages);'
      : a.path==='./owner-telegram' ? 'export const sendOwnerTelegram=()=>globalThis.__ugcTest.notify();'
      : 'export const lastWordIsBlogger=()=>globalThis.__ugcTest.live; export const sendIgDirect=(...args)=>globalThis.__ugcTest.send(...args); export const sendIgCards=(...args)=>globalThis.__ugcTest.cards(...args);' }));
  }}] });
const { igDmReply } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive:true });
const good = JSON.stringify({reply:'Получила, проверяю!',escalate:false,reason:'ok'});
function fixture() {
  const t = new Date(Date.now()-300_000).toISOString(), cid='conversation', states=new Map(), sent=[], notices=[], systems=[], sqls=[];
  const f = { t,cid,states,sent,notices,systems,sqls,live:true,raw:good,failBatch:false,
    async generate(messages) { systems.push(messages[0].content); f.context=messages[1].content; if(f.providerError) throw Error('provider'); return {text:f.raw}; },
    async notify(){notices.push(true);return true;},
    async send(...args){sent.push(args);return {ok:!f.sendError};}, async cards(_e,_h,urls){f.cardUrls=urls;return urls.length;}
  };
  f.env={DB:{prepare(sql){let p=[];sqls.push(sql);const st={bind(...v){p=v;return st;},async all(){
    if(sql.includes('WITH last')) return {results:[{cid,t,h:'tester'}]};
    if(sql.includes('SELECT direction'))return {results:[{direction:'in',text:'Подскажите',created_at:t}]};
    if(sql.includes('SELECT amount_minor'))return {results:f.payouts??[]};
    throw Error('unexpected all '+sql);
  },async first(){
    if(sql.includes('SELECT value'))return states.has(p[0])?{value:states.get(p[0])}:null;
    if(sql.includes('SELECT c.id'))return f.creator??null;
    if(sql.includes('SELECT creator_id'))return f.newCreator ? null : {creator_id:'creator',id:'profile'};
    if(sql.includes('COUNT(*) n'))return {n:0};
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
 assert.equal(incident(f).status,'needs_review');assert.equal(incident(f).attempts,3);assert.equal(handled(f),undefined);assert.equal(f.notices.length,1);
 await igDmReply(f.env);assert.equal(f.notices.length,1);assert.equal(f.systems.length,3);
});
test('business review remains open without sending or retrying',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:null,escalate:true,reason:'спор о старой оплате'});await igDmReply(f.env);await igDmReply(f.env);
 assert.equal(incident(f).kind,'business');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);assert.equal(f.notices.length,1);
});
test('payout database failure sends no acknowledgement and is not handled',async()=>{
 const f=fixture();f.failBatch=true;f.raw=JSON.stringify({reply:'Получила, проверяю!',escalate:false,requisites:{amount_rub:900,phone:'+79001112233',bank:'Сбер',last_name:'Тестова',first_name:'Анна'}});
 await igDmReply(f.env);assert.equal(incident(f).reason,'payout_registration_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
});
test('unknown live conversation and failed send remain pending',async()=>{
 const f=fixture();f.live=null;await igDmReply(f.env);assert.equal(incident(f).reason,'conversation_check_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
 const g=fixture();g.sendError=true;await igDmReply(g.env);assert.equal(incident(g).reason,'send_failed');assert.equal(handled(g),undefined);
});
test('provider outage remains pending',async()=>{const f=fixture();f.providerError=true;await igDmReply(f.env);assert.equal(incident(f).reason,'provider_error');assert.equal(handled(f),undefined);});
test('safe no-answer and confirmed existing reply are handled',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:null,escalate:false});await igDmReply(f.env);assert.equal(handled(f),f.t);
 const g=fixture();g.live=false;await igDmReply(g.env);assert.equal(handled(g),g.t);assert.equal(g.sent.length,0);
});
test('runtime appends the current menu and sends exactly four cards',async()=>{
 const f=fixture();f.raw=JSON.stringify({reply:'Вот четыре сценария — какой вам ближе?',escalate:false,send_cards:true});await igDmReply(f.env);
 assert.equal(f.cardUrls.length,4);assert.match(f.cardUrls[2],/261017\/card3/);assert.match(f.systems[0],/ТОЛЬКО ЧЕТЫРЕ/);
 assert.match(f.sqls.find(s=>s.includes('WITH last')),/m.created_at >= \?1/);
});
test('an older paid basket does not permit saying the new basket is paid',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:90000,status:'awaiting_approval',payout_date:'2026-10-17'},{amount_minor:75800,status:'paid',konsol_payment_id:'old',payout_date:'2026-10-16'}];
 f.raw=JSON.stringify({reply:'Перевели 900 ₽ — дошло?',escalate:false});await igDmReply(f.env);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'claims money sent, not paid in ERP');
});

test('a live profile containing the retired menu is overridden by the current four',async()=>{
 const f=fixture(); f.env.GITHUB_TOKEN='test-only';const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('Старое меню: семь сценариев.',{status:200});
 try { await igDmReply(f.env);assert.ok(f.systems[0].lastIndexOf('ТОЛЬКО ЧЕТЫРЕ')>f.systems[0].indexOf('семь сценариев')); }
 finally {globalThis.fetch=original;}
});

test('a registry-only paid row is described as unconfirmed, never unpaid or executed',async()=>{
 const f=fixture();f.creator={id:'creator'};f.payouts=[{amount_minor:90000,status:'paid',payout_date:'2026-10-17',konsol_payment_id:null}];
 f.raw=JSON.stringify({reply:'Перевели 900 ₽ — дошло?',escalate:false});await igDmReply(f.env);
 assert.match(f.context,/исполнение перевода не подтверждено/);assert.equal(f.sent.length,0);assert.equal(incident(f).reason,'claims money sent, not paid in ERP');
});

test('creator registration failure stays pending without any acknowledgement',async()=>{
 const f=fixture();f.newCreator=true;f.failBatch=true;await igDmReply(f.env);assert.equal(incident(f).reason,'creator_registration_failed');assert.equal(handled(f),undefined);assert.equal(f.sent.length,0);
});
