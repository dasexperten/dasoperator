import type {Env} from '../types';
import {pendingDianaMessages} from './diana-alarm';
import {reserveDianaCloud,releaseDianaCloud} from './diana-cloud-lock';
// @ts-expect-error plain JS module
import {directAnswerHours} from './diana-work-window.mjs';

// The detector supplies IDs only. Content is fetched by the Workflow itself.
export async function dispatchDianaDirect(env:Env,priorityEventId?:string,now=Date.now()){
 if(!directAnswerHours(now))return {dispatched:false,reason:'outside_direct_hours'};
 const active=await env.DB.prepare("SELECT value,updated_at FROM crm_sync_state WHERE key='diana_direct_active'").first<{value:string;updated_at:number}>();
 if(active){
  if(now-Number(active.updated_at)<180000)return {dispatched:false,reason:'diana_cloud_working'};
  let status:string;
  try{status=String((await(await env.DIANA_DIRECT.get(active.value)).status()).status);}catch{return {dispatched:false,reason:'workflow_status_unknown'};}
  if(!['complete','errored','terminated'].includes(status))return {dispatched:false,reason:'diana_cloud_working'};
  const mapping=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_direct_instance:'+active.value).first<{value:string}>();
  let eventIds:string[];try{const m=JSON.parse(mapping?.value??'null');eventIds=Array.isArray(m?.event_ids)?m.event_ids:m?.event_id?[m.event_id]:[];}catch{return {dispatched:false,reason:'workflow_mapping_missing'};}
  if(!eventIds.length||eventIds.some(id=>typeof id!=='string'))return {dispatched:false,reason:'workflow_mapping_missing'};
  for(const eventId of eventIds)await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
   .bind('diana_direct_event:'+eventId,JSON.stringify({status:'needs_review',reason:'terminal_workflow_without_verified_receipt',review_owner:'diana-helios',review_since_ms:now}),now).run();
  await releaseDianaCloud(env,{kind:'direct',id:active.value});
  await env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_direct_active' AND value=?1").bind(active.value).run();
 }
 // Owner 2026-11-11: payment messages (paid / bank declined) are Diana Direct's first job.
 const notice=(e:any)=>['payout_paid_notice','payout_failed_notice'].includes(e.task)&&typeof e.payout_id==='string'&&String(e.event_id).startsWith('action:')&&String(e.queue_key).startsWith('diana_action_pending:')&&typeof e.cid==='string';
 // Owner 2026-11-11: his Telegram decision is carried out by Diana Direct.
 const nudge=(e:any)=>e.task==='lead_nudge'&&String(e.event_id).startsWith('action:')&&String(e.queue_key).startsWith('diana_action_pending:')&&typeof e.cid==='string';
 const gold=(e:any)=>(e.task==='gold_welcome'||nudge(e))&&String(e.event_id).startsWith('action:')&&String(e.queue_key).startsWith('diana_action_pending:')&&typeof e.cid==='string';
 const choice=(e:any)=>e.task==='owner_choice'&&typeof e.question_id==='string'&&String(e.event_id).startsWith('action:')&&String(e.queue_key).startsWith('diana_action_pending:')&&typeof e.cid==='string';
 const pending=(await pendingDianaMessages(env,now)).filter((e:any)=>notice(e)||choice(e)||gold(e)||
  typeof e.message_id==='string' && e.event_id==='message:'+e.message_id && String(e.queue_key).startsWith('diana_round_alarm:'));
 pending.sort((a:any,b:any)=>Number(notice(b))-Number(notice(a))||Number(choice(b))-Number(choice(a))||Number(gold(b))-Number(gold(a))||Number(b.event_id===priorityEventId&&!!priorityEventId)-Number(a.event_id===priorityEventId&&!!priorityEventId)||Date.parse(b.at??0)-Date.parse(a.at??0));
 const ready:{item:any;attempt:number;revisit?:boolean}[]=[];let earliest=Infinity;
 for(const item of pending){
  let nextAttempt=1;
  const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_direct_event:'+item.event_id).first<{value:string}>();
  let state:any=null;try{state=row?JSON.parse(row.value):null;}catch{continue;}
  let revisit=false;
  if(state){
   // Owner 2026-11-11: a parked chat is never left alone. Once, 10 minutes after
   // parking, Diana looks again and must answer or ask. An unknown send is never replayed.
   const parked=state.status==='needs_review'||(state.status==='pending'&&Number(state.attempt??1)>=3);
   if(parked){
    const unknownSend=/delivery_unknown|delivery_unconfirmed/.test(String(state.reason??''));
    if(!state.revisited&&!unknownSend&&!notice(item)&&!choice(item)&&!gold(item)){
     if(now-Number(state.review_since_ms??0)<600000){earliest=Math.min(earliest,Number(state.review_since_ms??0)+600000);continue;}
     revisit=true;
    }else{
     // Owner 2026-11-11: no Telegram for parked chats; it stays visible in the ERP.
     continue;
    }
   }else{
    if(state.status!=='pending'||!['original_attachment_unavailable','original_image_unreadable','direct_execution_failed'].includes(state.reason))continue;
    const retryAt=Number(state.retry_at??0);if(retryAt>now){earliest=Math.min(earliest,retryAt);continue;}
    nextAttempt=Number(state.attempt??1)+1;
   }
  }
  ready.push({item,attempt:nextAttempt,revisit});if(ready.length>=4)break;
 }
 if(!ready.length)return Number.isFinite(earliest)?{dispatched:false,reason:'media_retry_waiting',retry_at:earliest}:{dispatched:false,reason:'no_direct_signal_ready'};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ready.map(({item,attempt})=>[item.event_id,attempt]))));
 const id='direct-'+[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
 const owner={kind:'direct' as const,id};
 if(!await reserveDianaCloud(env,owner))return {dispatched:false,reason:'diana_cloud_locked'};
 const claim=await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_direct_active',?1,?2) ON CONFLICT(key) DO NOTHING").bind(id,now).run();
 if(!claim.meta.changes){await releaseDianaCloud(env,owner);return {dispatched:false,reason:'diana_cloud_working'};}
 await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
  .bind('diana_direct_instance:'+id,JSON.stringify({event_ids:ready.map(({item})=>item.event_id),created_at:now}),now).run();
 try{
  await env.DIANA_DIRECT.create({id,params:{events:ready.map(({item,attempt,revisit})=>({cid:String(item.cid),message_id:item.message_id??null,event_id:item.event_id,handle:item.handle,attempt,...(notice(item)?{task:item.task,payout_id:item.payout_id}:{}),...(choice(item)?{task:item.task,question_id:item.question_id}:{}),...(gold(item)?{task:item.task}:{}),...(revisit?{revisit:true}:{})}))}});
 }catch{
  // An uncertain create cannot be replayed blindly; preserve claim and lock.
  return {dispatched:false,reason:'workflow_creation_unknown'};
 }
 return {dispatched:true,workflow_id:id,event_ids:ready.map(({item})=>item.event_id)};
}
