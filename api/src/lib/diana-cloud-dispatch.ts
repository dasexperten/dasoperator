import type { Env } from '../types';
import { pendingDianaMessages } from './diana-alarm';
import { dianaWorkWindow } from './diana-work-window.mjs';
import { readDianaCloudLock, releaseDianaCloud, reserveDianaCloud, recoverDianaCloudLock } from './diana-cloud-lock';

// One durable workflow at a time, across metadata scans and connected machines.
// The Durable Object serializes dispatch; instance identity makes creation replay-safe.
export async function dispatchDianaCloud(env:Env,priorityEventId?:string, now=Date.now()) {
  if(!dianaWorkWindow(now).direct)return {dispatched:false,reason:'outside_direct_hours'};
  const claim=await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if(claim&&Number(claim.updated_at)>Date.now()-180_000)return {dispatched:false,reason:'diana_machine_finishing'};
  const active=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_cloud_active'").first<{value:string}>();
  if(active){
    const finished=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_finished:'+active.value).first<{value:string}>();
    let finishedHere=false;
    try {const proof=JSON.parse(finished?.value??'null');finishedHere=proof?.kind==='direct'&&proof.id===active.value;} catch {}
    if(!finishedHere){
    try {
      const instance=await env.DIANA_CLOUD.get(active.value);
      const status=await instance.status();
      if(!['complete','errored','terminated'].includes(status.status))return {dispatched:false,reason:'diana_cloud_working',workflow_id:active.value};
      // Only a positively terminal workflow permits recovery after an abrupt
      // runtime failure. Never evict a live or unidentifiable owner by age.
      await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_cloud_recovery:direct:'+active.value,JSON.stringify({owner:{kind:'direct',id:active.value},reason:'terminal_workflow_observed',status:status.status,checked_at:Date.now()}),Date.now()).run();
      await releaseDianaCloud(env,{kind:'direct',id:active.value});
    } catch(error) {
      // Only a positively identified missing instance permits replay of create.
      if(!/not found|does not exist|not exist/i.test(String((error as Error)?.message??error)))throw error;
    }
    }
  }
  const financial=(e:any)=>['payout_paid_notice','payout_failed_notice'].includes(e.task)&&e.payout_id&&String(e.event_id).startsWith('action:');
  const ownerChoice=(e:any)=>e.task==='owner_choice'&&e.question_id&&String(e.event_id).startsWith('action:');
  const waiting=(await pendingDianaMessages(env)).filter(e=>e.message_id&&(financial(e)||ownerChoice(e)||String(e.queue_key).startsWith('diana_round_alarm:')&&e.event_id==='message:'+e.message_id))
    .sort((a,b)=>Number(b.event_id===priorityEventId)-Number(a.event_id===priorityEventId)||Number(!!financial(b))-Number(!!financial(a))||Date.parse(b.at)-Date.parse(a.at));
  for(const event of waiting){
    const known=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_event:'+event.event_id).first<{value:string}>();
    let deferred=false;if(known){try{deferred=JSON.parse(known.value)?.status==='deferred';}catch{}}
    if(known&&!deferred)continue; // errors/unknowns never replay automatically
    const identity=deferred?`${event.event_id}:resume:${dianaWorkWindow(now).date}`:event.event_id;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const id='direct-v1-'+hash;
    const previous=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_recovery:direct:'+id).first<{value:string}>();
    let terminal=false;try{terminal=JSON.parse(previous?.value??'null')?.reason==='terminal_workflow_observed';}catch{}
    if(terminal){
      await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind('diana_cloud_event:'+event.event_id,JSON.stringify({status:'needs_review',reason:'terminal_workflow_without_verified_receipt',workflow_id:id}),Date.now()).run();
      continue;
    }
    if(!await reserveDianaCloud(env,{kind:'direct',id})){
      const recovery=await recoverDianaCloudLock(env);
      if(!recovery.released||!await reserveDianaCloud(env,{kind:'direct',id})){
        const owner=await readDianaCloudLock(env);
        return {dispatched:false,reason:'diana_cloud_locked',owner,recovery:recovery.reason};
      }
    }
    // Write the exact instance ID before creation. A lost create acknowledgement
    // is recovered by get(id); never mint a second instance for the same event.
    await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_cloud_active',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(id,Date.now()).run();
    try { await env.DIANA_CLOUD.create({id,params:{cid:event.cid,message_id:event.message_id,event_id:event.event_id,handle:event.handle,at:event.at,
      ...(financial(event)?{task:event.task,payout_id:event.payout_id}:ownerChoice(event)?{task:'owner_choice',question_id:String(event.question_id)}:{})}}); }
    catch(error){
      // A nonexistent instance is a real failed create, and leaves the pending
      // metadata untouched. A duplicate-ID response resolves to the same work.
      try {await (await env.DIANA_CLOUD.get(id)).status();}catch{throw error;}
    }
    return {dispatched:true,executor:'cloudflare_workflow',workflow_id:id,event_ids:[event.event_id]};
  }
  return {dispatched:false,reason:waiting.length?'cloud_events_await_review':'queue_empty',pending:waiting.length};
}
