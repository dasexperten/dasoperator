import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {runRoundCreator} from './diana-round-run.mjs';
const now=Date.parse('2026-11-11T02:00:00Z'),H=3600_000;
function setup({lastOutAgo=30*H,lastInAgo=40*H,lastFrom='us',decision={action:'send',reply:'Мария, как ваш заказ? Пришёл? 🌷'}}={}){
 const s=new DatabaseSync(':memory:');s.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_payouts(creator_id TEXT,status TEXT,amount_minor INTEGER,paid_at TEXT,created_at INTEGER)');
 const env={GITHUB_TOKEN:'x',DB:{prepare(sql){let v=[];return{bind(...a){v=a;return this},async first(){return s.prepare(sql).get(...v)??null},async all(){return{results:s.prepare(sql).all(...v)}},async run(){return{meta:{changes:Number(s.prepare(sql).run(...v).changes)}}}}}}};
 const msgs=[{id:'i',created_time:new Date(now-lastInAgo).toISOString(),from:{id:'blogger'},message:'Заказала'},{id:'o',created_time:new Date(now-lastOutAgo).toISOString(),from:{id:'17841466350261166'},message:'Пришлите скрин заказа'}];
 if(lastFrom==='her')msgs.push({id:'i2',created_time:new Date(now-H).toISOString(),from:{id:'blogger'},message:'?'});
 const sent=[];
 const fetchImpl=async(url,init)=>{const u=String(url);
  if(u.includes('fields=access_token'))return Response.json({access_token:'page'});
  if(u.includes('/messages?'))return Response.json({data:msgs.slice().reverse()});
  if(init?.method==='POST'){sent.push(JSON.parse(init.body));return Response.json({message_id:'out-'+sent.length});}
  const m=u.match(/\/(out-\d+)\?/);if(m){const b=sent[Number(m[1].slice(4))-1];return Response.json({id:m[1],message:b.message.text,from:{id:'17841466350261166'}});}
  return Response.json({});};
 return{s,sent,args:{env,runId:'r1',person:{id:'c1',normalized_handle:'maria',lifecycle_stage:'ordered',cid:'chat'},token:'t',fetchImpl,now,
  infer:async()=>({text:JSON.stringify(decision)}),prepareContext:async()=>({system:'rules'})}};
}
test('a silent blogger at a working stage gets one follow-up, and never twice in the same round',async()=>{
 const f=setup();const r=await runRoundCreator(f.args);assert.equal(r.status,'sent');assert.equal(f.sent.length,1);
 assert.equal((await runRoundCreator(f.args)).reason,'already_done_this_round');assert.equal(f.sent.length,1);
});
test('no follow-up when she wrote last, when we wrote recently, outside the window, or when Diana decides none',async()=>{
 for(const [opts,reason] of [[{lastFrom:'her'},'creator_waiting_direct_answers'],[{lastOutAgo:5*H},'written_recently'],[{lastInAgo:8*24*H},'outside_instagram_window'],[{decision:{action:'none',reply:null}},'diana_decided_no_follow_up']]){
  const f=setup(opts);const r=await runRoundCreator(f.args);assert.equal(r.reason,reason);assert.equal(f.sent.length,0);}
});
