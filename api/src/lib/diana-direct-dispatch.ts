import type {Env} from '../types';
import {pendingDianaMessages} from './diana-alarm';
import {reserveDianaCloud,releaseDianaCloud} from './diana-cloud-lock';
// @ts-expect-error plain JS module
import {dianaWorkWindow} from './diana-work-window.mjs';

// The detector supplies IDs only. Content is fetched by the Workflow itself.
export async function dispatchDianaDirect(env:Env,priorityEventId?:string,now=Date.now()){
 if(!dianaWorkWindow(now).direct)return {dispatched:false,reason:'outside_direct_hours'};
 const active=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_direct_active'").first<{value:string}>();
 if(active)return {dispatched:false,reason:'diana_cloud_working'};
 const pending=(await pendingDianaMessages(env,now)).filter((e:any)=>
  typeof e.message_id==='string' && e.event_id==='message:'+e.message_id && String(e.queue_key).startsWith('diana_round_alarm:'));
 pending.sort((a:any,b:any)=>Number(b.event_id===priorityEventId&&!!priorityEventId)-Number(a.event_id===priorityEventId&&!!priorityEventId)||Date.parse(b.at??0)-Date.parse(a.at??0));
 let next:any=null, nextAttempt=1, earliest=Infinity;
 for(const item of pending){
  const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_direct_event:'+item.event_id).first<{value:string}>();
  let state:any=null;try{state=row?JSON.parse(row.value):null;}catch{continue;}
  if(state){
   if(state.status!=='pending'||!['original_attachment_unavailable','original_image_unreadable','direct_execution_failed'].includes(state.reason))continue;
   if(Number(state.attempt??1)>=3)continue;
   const retryAt=Number(state.retry_at??0);if(retryAt>now){earliest=Math.min(earliest,retryAt);continue;}
   nextAttempt=Number(state.attempt??1)+1;
  }
  next=item;break;
 }
 if(!next)return Number.isFinite(earliest)?{dispatched:false,reason:'media_retry_waiting',retry_at:earliest}:{dispatched:false,reason:'no_direct_signal_ready'};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(next.event_id+':'+nextAttempt));
 const id='direct-'+[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
 const owner={kind:'direct' as const,id};
 if(!await reserveDianaCloud(env,owner))return {dispatched:false,reason:'diana_cloud_locked'};
 const claim=await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_direct_active',?1,?2) ON CONFLICT(key) DO NOTHING").bind(id,now).run();
 if(!claim.meta.changes){await releaseDianaCloud(env,owner);return {dispatched:false,reason:'diana_cloud_working'};}
 try{
  await env.DIANA_DIRECT.create({id,params:{cid:String(next.cid),message_id:next.message_id,event_id:next.event_id,handle:next.handle,attempt:nextAttempt}});
 }catch{
  // An uncertain create cannot be replayed blindly; preserve claim and lock.
  return {dispatched:false,reason:'workflow_creation_unknown'};
 }
 return {dispatched:true,workflow_id:id,event_id:next.event_id};
}
