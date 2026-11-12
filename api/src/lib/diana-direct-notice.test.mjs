import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {runPayoutNotice,runGoldWelcome} from './diana-direct-notice.mjs';
function db(){const d=new DatabaseSync(':memory:');d.exec(`CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,handle TEXT,status TEXT,amount_minor INTEGER,konsol_payment_id TEXT,konsol_status TEXT,paid_at TEXT,failed_at TEXT,notice_status TEXT,notice_message_id TEXT,notice_error TEXT,notice_at TEXT,paid_notice_at TEXT,updated_at INTEGER);CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);`);
 const wrap=s=>({bind:(...a)=>({first:async()=>d.prepare(s).get(...a)??null,run:async()=>({meta:{changes:d.prepare(s).run(...a).changes}}),_s:s,_a:a})});
 return{d,env:{GITHUB_TOKEN:'t',DB:{prepare:wrap,batch:async st=>st.map(x=>({meta:{changes:d.prepare(x._s).run(...x._a).changes}}))}}};}
function meta(sent){return async(url,init)=>{const u=String(url);
 if(u.includes('fields=access_token'))return new Response(JSON.stringify({access_token:'p'}));
 if(u.includes('/messages?fields'))return new Response(JSON.stringify({data:[{id:'m2',from:{id:'u1',username:'alice'},message:'+79990000000 Сбер Анна',created_time:'2026-11-11T08:00:00Z'},{id:'m1',from:{id:'17841466350261166'},message:'Пришлите реквизиты',created_time:'2026-11-11T07:59:00Z'}]}));
 if(init?.method==='POST'){const b=JSON.parse(init.body);sent.push(b);return new Response(JSON.stringify({message_id:'out1'}));}
 if(u.includes('out1?'))return new Response(JSON.stringify({id:'out1',message:sent.at(-1).message.text,from:{id:'17841466350261166'}}));
 throw Error('unexpected '+u);};}
const ctx=async()=>({system:'DIANA'});
test('Owner 11.11: confirmed paid payout -> Diana writes the notice, Meta receipt read back, payout marked delivered, never twice',async()=>{
 const {d,env}=db();d.prepare("INSERT INTO ugc_payouts(id,handle,status,amount_minor,konsol_payment_id,konsol_status,paid_at) VALUES('p1','alice','paid',45300,'k1','executed','2026-11-11T08:05:00Z')").run();
 const sent=[];let prompt='';const infer=async(m)=>{prompt=m[0].content;return{text:JSON.stringify({reply:'Перевели 453 ₽ по СБП, проверьте, пожалуйста) Теперь оформите заказ и пришлите скрин.'})};};
 const ev={cid:'c1',message_id:'m2',event_id:'action:x',task:'payout_paid_notice',payout_id:'p1'};
 const r=await runPayoutNotice({env,event:ev,token:'t',infer,prepareContext:ctx,fetchImpl:meta(sent)});
 assert.equal(r.status,'complete');/* Owner 2026-11-12: notice, three idea lines, four cards */assert.equal(sent.length,8);assert.equal(sent[0].recipient.id,'u1');assert.match(sent[1].message.text,/свою идею/);assert.match(sent[2].message.text,/лицо.*только про распаковку/s);assert.equal(sent.slice(4).filter(x=>x.message.attachment?.type==='image').length,4);assert.match(prompt,/453 ₽/);
 assert.equal(d.prepare("SELECT notice_status FROM ugc_payouts").get().notice_status,'delivered');
 const again=await runPayoutNotice({env,event:ev,token:'t',infer,prepareContext:ctx,fetchImpl:meta(sent)});
 assert.equal(again.status,'complete');assert.equal(sent.length,8);
});
test('an unconfirmed payout sends nothing',async()=>{
 const {d,env}=db();d.prepare("INSERT INTO ugc_payouts(id,handle,status,amount_minor) VALUES('p1','alice','approved',45300)").run();
 const sent=[];const r=await runPayoutNotice({env,event:{cid:'c1',message_id:'m2',event_id:'action:x',task:'payout_paid_notice',payout_id:'p1'},token:'t',infer:async()=>({text:'{"reply":"x"}'}),prepareContext:ctx,fetchImpl:meta(sent)});
 assert.equal(r.status,'pending');assert.equal(sent.length,0);
});

test('Owner 2026-11-12: a Gold welcome for a blogger silent over 7 days waits in the Chrome queue, nothing is sent',async()=>{
 const {d,env}=db();const sent=[];
 const infer=async()=>({text:JSON.stringify({reply:'Анна, вы в закрытом круге Gold.'})});
 const ev={cid:'c1',message_id:null,event_id:'action:gold-1',task:'gold_welcome',handle:'alice'};
 const r=await runGoldWelcome({env,event:ev,token:'t',infer,prepareContext:ctx,fetchImpl:meta(sent),now:Date.parse('2026-11-25T08:00:00Z')});
 assert.equal(r.status,'complete');assert.equal(r.reason,'gold_welcome_queued');assert.equal(sent.length,0);
 const q=JSON.parse(d.prepare("SELECT value FROM crm_sync_state WHERE key='browser_queue:alice'").get().value);
 assert.equal(q.kind,'gold');assert.equal(q.items[0].text,'Анна, вы в закрытом круге Gold.');
 const again=await runGoldWelcome({env,event:ev,token:'t',infer,prepareContext:ctx,fetchImpl:meta(sent),now:Date.parse('2026-11-25T08:05:00Z')});
 assert.equal(again.reason,'gold_welcome_queued');assert.equal(JSON.parse(d.prepare("SELECT value FROM crm_sync_state WHERE key='browser_queue:alice'").get().value).items.length,1);
});
