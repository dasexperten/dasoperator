import type { Env } from '../types';
import { pendingDianaMessages } from './diana-alarm';

// One durable workflow at a time, across metadata scans and connected machines.
// The Durable Object serializes dispatch; instance identity makes creation replay-safe.
export async function dispatchDianaCloud(env:Env,priorityEventId?:string) {
  const claim=await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if(claim&&Number(claim.updated_at)>Date.now()-180_000)return {dispatched:false,reason:'diana_machine_finishing'};
  const active=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_cloud_active'").first<{value:string}>();
  if(active){
    try {
      const instance=await env.DIANA_CLOUD.get(active.value);
      const status=await instance.status();
      if(!['complete','errored','terminated'].includes(status.status))return {dispatched:false,reason:'diana_cloud_working',workflow_id:active.value};
    } catch(error) {
      // Only a positively identified missing instance permits replay of create.
      if(!/not found|does not exist|not exist/i.test(String((error as Error)?.message??error)))throw error;
    }
  }
  const waiting=(await pendingDianaMessages(env)).filter(e=>String(e.queue_key).startsWith('diana_round_alarm:')&&e.message_id&&e.event_id==='message:'+e.message_id)
    .sort((a,b)=>Number(b.event_id===priorityEventId)-Number(a.event_id===priorityEventId)||Date.parse(b.at)-Date.parse(a.at));
  for(const event of waiting){
    const known=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_cloud_event:'+event.event_id).first();
    if(known)continue; // incomplete/failed events stay visible; no infinite automatic restart
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const id='direct-v1-'+hash;
    // Write the exact instance ID before creation. A lost create acknowledgement
    // is recovered by get(id); never mint a second instance for the same event.
    await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_cloud_active',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(id,Date.now()).run();
    try { await env.DIANA_CLOUD.create({id,params:{cid:event.cid,message_id:event.message_id,event_id:event.event_id,handle:event.handle,at:event.at}}); }
    catch(error){
      // A nonexistent instance is a real failed create, and leaves the pending
      // metadata untouched. A duplicate-ID response resolves to the same work.
      try {await (await env.DIANA_CLOUD.get(id)).status();}catch{throw error;}
    }
    return {dispatched:true,executor:'cloudflare_workflow',workflow_id:id,event_ids:[event.event_id]};
  }
  return {dispatched:false,reason:waiting.length?'cloud_events_await_review':'queue_empty',pending:waiting.length};
}
