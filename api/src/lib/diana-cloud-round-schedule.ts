import type {Env} from '../types';
import {reserveDianaCloud,releaseDianaCloud,recoverDianaCloudLock} from './diana-cloud-lock';

// Cloudflare timestamps are UTC; Moscow is UTC+3. A slot has one stable id,
// including retries after an ambiguous create response.
export function dianaRoundSlot(at:number) {
  const date=new Date(at+3*3600_000), minutes=date.getUTCHours()*60+date.getUTCMinutes();
  const period=minutes<30?'night':minutes>=360&&minutes<390?'morning':null;
  return period?{id:`diana-round-${date.toISOString().slice(0,10)}-${period}`,period,lastMinute:minutes===29||minutes===389}:null;
}

export async function scheduleDianaRound(env:Env, at:number) {
  const mode=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_cloud_mode'").first<{value:string}>();
  if(mode?.value!=='enabled')return {scheduled:false,reason:'cloud_disabled'};
  const nowSlot=dianaRoundSlot(at);
  if(nowSlot)await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
    .bind('diana_round_run:'+nowSlot.id,JSON.stringify({status:'waiting',id:nowSlot.id,scheduled_at:at,reason:'awaiting_shared_lock'}),at).run();
  const pending=await env.DB.prepare(`SELECT key,value FROM crm_sync_state WHERE key LIKE 'diana_round_run:%' AND json_valid(value)
    AND json_extract(value,'$.status')='waiting' ORDER BY updated_at LIMIT 1`).first<{key:string;value:string}>();
  if(!pending)return {scheduled:false,reason:nowSlot?'already_started':'outside_round_window'};
  const saved=JSON.parse(pending.value);const slot={id:String(saved.id),scheduled_at:Number(saved.scheduled_at)};
  if(!/^diana-round-\d{4}-\d{2}-\d{2}-(morning|night)$/.test(slot.id)||!Number.isFinite(slot.scheduled_at))throw Error('round_waiting_record_invalid');
  const owner={kind:'round' as const,id:slot.id};
  async function busy(reason:string){
    return {scheduled:false,reason,id:slot.id,queued:true};
  }
  if(!await reserveDianaCloud(env,owner)){
    const recovery=await recoverDianaCloudLock(env);
    if(!recovery.released||!await reserveDianaCloud(env,owner))return {...await busy('diana_busy'),recovery:recovery.reason};
  }
  // A legacy M1 execution cannot join the new lock, so defer while its claim
  // is fresh, without deleting that claim or starting a simultaneous round.
  const machine=await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if(machine&&Number(machine.updated_at)>Date.now()-180_000){await releaseDianaCloud(env,owner);return busy('machine_busy');}
  // Write the deterministic id before creating. If creation acknowledgement is
  // lost, the same id is inspected; a second id must never be minted.
  const marked=await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
    .bind(pending.key,JSON.stringify({status:'starting',id:slot.id,scheduled_at:slot.scheduled_at}),Date.now(),pending.value).run();
  if(Number(marked.meta.changes)!==1){await releaseDianaCloud(env,owner);return {scheduled:false,reason:'round_state_changed'};}
  try { await env.DIANA_ROUND.create({id:slot.id,params:{id:slot.id,scheduled_at:slot.scheduled_at}}); }
  catch(error){try{await(await env.DIANA_ROUND.get(slot.id)).status();}catch{throw error;}}
  return {scheduled:true,id:slot.id};
}
