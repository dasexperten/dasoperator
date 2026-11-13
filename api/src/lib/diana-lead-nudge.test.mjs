import test from 'node:test';import assert from 'node:assert/strict';
import {runLeadNudge,scheduleLeadNudge,NUDGE_TASK,NUDGE_INSTRUCTION} from './diana-direct-notice.mjs';
const fakeDb=(stage=null)=>{const kv=new Map();return{kv,prepare(sql){return{bind(...a){return{
 first:async()=>sql.includes('lifecycle_stage')?(stage?{s:stage}:null):(kv.has(a[0])?{value:kv.get(a[0])}:null),
 run:async()=>{if(sql.startsWith('DELETE'))kv.delete(a[0]);else if(sql.includes('DO NOTHING')){if(kv.has(a[0]))return{meta:{changes:0}};kv.set(a[0],a[1]);}else kv.set(a[0],sql.startsWith('UPDATE')?a[1]:a[1]);return{meta:{changes:1}};}};}};}};};
const PAGE='1697038263872226';
const fetchOf=(msgs,sent=[])=>async(url,init)=>{const u=String(url);
 if(u.includes('fields=access_token'))return{ok:true,json:async()=>({access_token:'pt'})};
 if(u.includes('/messages?fields=id,created_time'))return{ok:true,json:async()=>({data:[...msgs].reverse()})};
 if(init?.method==='POST'){const b=JSON.parse(init.body);sent.push(b.message.text);return{ok:true,json:async()=>({message_id:'m1'})};}
 if(u.includes('m1?fields'))return{ok:true,json:async()=>({id:'m1',message:sent.at(-1),from:{id:PAGE}})};
 return{ok:true,json:async()=>({})};};
const base={task:NUDGE_TASK,cid:'c1',event_id:'action:x',handle:'natali'};
const t0=Date.parse('2026-11-13T12:00:00Z');
const conv=[{id:'1',from:{id:'u1',username:'natali'},message:'давайте пробовать',created_time:'2026-11-12T19:16:00Z'},{id:'2',from:{id:PAGE},message:'Натали, на Ozon наберите…',created_time:'2026-11-12T19:21:00Z'}];
test('Owner 2026-11-13: a silent lead gets Diana\'s own nudge',async()=>{
 const sent=[];const env={DB:fakeDb('agreed'),GITHUB_TOKEN:''};
 const r=await runLeadNudge({env,event:base,token:'t',now:t0,fetchImpl:fetchOf(conv,sent),prepareContext:async()=>({system:'S'}),infer:async(m)=>{assert.ok(m[0].content.includes('DH-HARD-261113-01'));return{text:JSON.stringify({reply:'Натали, получилось найти TERMO?'})};}});
 assert.equal(r.status,'complete');assert.equal(sent[0],'Натали, получилось найти TERMO?');
});
test('she answered, or she is already paid — no nudge',async()=>{
 const r1=await runLeadNudge({env:{DB:fakeDb('agreed')},event:base,token:'t',now:t0,fetchImpl:fetchOf([...conv,{id:'3',from:{id:'u1',username:'natali'},message:'ок',created_time:'2026-11-13T10:00:00Z'}]),prepareContext:async()=>({system:''}),infer:async()=>{throw Error('no');}});
 assert.equal(r1.reason,'nudge_creator_answered');
 const r2=await runLeadNudge({env:{DB:fakeDb('paid')},event:{...base,event_id:'action:y'},token:'t',now:t0,fetchImpl:fetchOf(conv),prepareContext:async()=>({system:''}),infer:async()=>{throw Error('no');}});
 assert.equal(r2.reason,'nudge_stage_paid');
});
test('schedule: lead gets a nudge in 3 hours; a paid blogger never',async()=>{
 const db=fakeDb('agreed');assert.equal(await scheduleLeadNudge(db,{cid:'c1',handle:'natali'},t0),true);
 assert.equal(JSON.parse(db.kv.get('lead_nudge:c1')).due,t0+3*3600000);
 assert.equal(await scheduleLeadNudge(fakeDb('paid'),{cid:'c1',handle:'natali'},t0),false);
});
