import type {Env} from '../types';
import {answerHardQuestion} from './ugc-hard-question';
const SOURCE='https://organizacia.dasexperten.workers.dev/api/telegram-bot/raw-updates?limit=100';
// Preserve exact Owner choices for processing; a raw callback is not proof
// that its original question was matched or that its action was executed.
export async function collectOwnerChoices(env:Env,roundId:string){
 try {
  const response=await fetch(SOURCE,{signal:AbortSignal.timeout(20_000)});
  const payload=await response.json() as any;
  if(!response.ok||payload.ok!==true||!Array.isArray(payload.items))throw Error('owner_choices_source_unavailable');
  const choices=payload.items.filter((x:any)=>x.agent_slug==='diana-helios'&&x.kind==='callback_query'&&x.reply_to_message_id&&Number.isSafeInteger(Number(x.update_id)));
  let unresolved=0;
  for(const x of choices){
   const key='diana_owner_choice:'+String(x.update_id);
   const item:any={status:'needs_review',reason:'original_question_and_action_not_verified',round_id:roundId,update_id:Number(x.update_id),
     reply_to_message_id:String(x.reply_to_message_id),choice:String(x.text??'').slice(0,500),source_at:x.created_at??null};
   const question=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('ig_hard:'+String(x.reply_to_message_id)).first<{value:string}>();
   const match=String(x.text??'').match(/^opt:\d+:(.+)$/s);
   if(question&&match){
    let q:any;try{q=JSON.parse(question.value);}catch{}
    const selected=match[1].trim();
    if(q?.options&&Object.prototype.hasOwnProperty.call(q.options,selected)&&(!q.choice||q.choice===selected)){
      const action=await answerHardQuestion(env,Number(x.reply_to_message_id),selected);
      if(action.event_id){item.status='queued';item.reason='awaiting_verified_delivery';item.event_id=action.event_id;}
      else if(q.answered_at){item.status='verified';item.reason='owner_choice_already_recorded';}
      else item.reason='owner_choice_not_queued';
    }
   }
   await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
     WHERE json_valid(crm_sync_state.value) AND json_extract(crm_sync_state.value,'$.status')<>'verified'`).bind(key,JSON.stringify(item),Date.now()).run();
   const saved=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
   if(!saved)throw Error('owner_choice_receipt_not_saved');
   if(JSON.parse(saved.value).status!=='verified')unresolved++;
  }
  return {status:unresolved||payload.items.length>=100?'needs_review':'verified',count:choices.length,unresolved,
    reason:payload.items.length>=100?'owner_choices_source_may_be_truncated':unresolved?'owner_choices_require_action_review':null};
 } catch(error){return {status:'needs_review',reason:String((error as Error)?.message??'owner_choices_source_unavailable').slice(0,100)};}
}
