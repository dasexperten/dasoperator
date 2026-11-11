import type {Env} from '../types';

// Owner 2026-11-11: Diana Round runs twice a day, 06:00 and 18:00 Yerevan (UTC+4),
// as its own process. A slot has one stable id; a lost create is inspected, never doubled.
export function dianaRoundSlot(at:number) {
  const date=new Date(at+4*3600_000), minutes=date.getUTCHours()*60+date.getUTCMinutes();
  const period=minutes>=360&&minutes<390?'morning':minutes>=1080&&minutes<1110?'evening':null;
  return period?{id:`diana-round-${date.toISOString().slice(0,10)}-${period}`,period}:null;
}

export async function scheduleDianaRound(env:Env, at:number) {
  const mode=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='diana_direct_mode'").first<{value:string}>();
  if(mode?.value!=='enabled')return {scheduled:false,reason:'direct_disabled'};
  const slot=dianaRoundSlot(at);
  if(!slot)return {scheduled:false,reason:'outside_round_window'};
  const claim=await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
    .bind('diana_round_run:'+slot.id,JSON.stringify({status:'starting',id:slot.id,scheduled_at:at}),at).run();
  if(!Number(claim.meta.changes))return {scheduled:false,reason:'already_started',id:slot.id};
  try { await env.DIANA_ROUND.create({id:slot.id,params:{id:slot.id,scheduled_at:at}}); }
  catch(error){try{await(await env.DIANA_ROUND.get(slot.id)).status();}catch{throw error;}}
  return {scheduled:true,id:slot.id};
}
