import type {Env} from '../types';
import {reserveDianaCloud,releaseDianaCloud} from './diana-cloud-lock';

// Cloudflare timestamps are UTC; Moscow is UTC+3. A slot has one stable id,
// including retries after an ambiguous create response.
export function dianaRoundSlot(at:number) {
  const date=new Date(at+3*3600_000), minutes=date.getUTCHours()*60+date.getUTCMinutes();
  const period=minutes<30?'night':minutes>=360&&minutes<390?'morning':null;
  return period?{id:`diana-round-${date.toISOString().slice(0,10)}-${period}`,period}:null;
}

export async function scheduleDianaRound(env:Env, at:number) {
  const slot=dianaRoundSlot(at);if(!slot)return {scheduled:false,reason:'outside_round_window'};
  const mode=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_cloud_mode'").first<{value:string}>();
  if(mode?.value!=='enabled')return {scheduled:false,reason:'cloud_disabled'};
  const old=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_round_run:'+slot.id).first();
  if(old)return {scheduled:false,reason:'already_started',id:slot.id};
  const owner={kind:'round' as const,id:slot.id};
  if(!await reserveDianaCloud(env,owner))return {scheduled:false,reason:'diana_busy',id:slot.id};
  // A legacy M1 execution cannot join the new lock, so defer while its claim
  // is fresh, without deleting that claim or starting a simultaneous round.
  const machine=await env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
  if(machine&&Number(machine.updated_at)>Date.now()-180_000){await releaseDianaCloud(env,owner);return {scheduled:false,reason:'machine_busy',id:slot.id};}
  // Write the deterministic id before creating. If creation acknowledgement is
  // lost, the same id is inspected; a second id must never be minted.
  await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
    .bind('diana_round_run:'+slot.id,JSON.stringify({status:'starting',id:slot.id,scheduled_at:at}),Date.now()).run();
  try { await env.DIANA_ROUND.create({id:slot.id,params:{id:slot.id,scheduled_at:at}}); }
  catch(error){try{await(await env.DIANA_ROUND.get(slot.id)).status();}catch{throw error;}}
  return {scheduled:true,id:slot.id};
}
