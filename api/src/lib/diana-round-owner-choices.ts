import type {Env} from '../types';
import {answerHardQuestion} from './ugc-hard-question';
const SOURCE='https://organizacia.dasexperten.workers.dev/api/telegram-bot/raw-updates?limit=100';
async function graph(path:string,key:string){const r=await fetch('https://graph.facebook.com/v21.0'+path,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20_000)});const data=await r.json() as any;if(!r.ok||data.error)throw Error('owner_receipt_original_unavailable');return data;}
const brandIds=['1697038263872226','17841466350261166'];
async function observeOldChoice(env:Env,q:any){
 const token=(env as any).META_IG_MESSAGING_TOKEN,when=Date.parse(String(q.decision_at??''));
 if(!token||!q.cid||!Number.isFinite(when))return {reason:'prior_choice_original_unavailable'};
 try {
  const page=await graph('/1697038263872226?fields=access_token',token);if(!page.access_token)throw Error('no_page_token');
  let after='',more=true,complete=false;const outgoing:string[]=[];
  for(let i=0;i<30&&more;i++){
   const body=await graph('/'+encodeURIComponent(String(q.cid))+'/messages?fields=id,from,created_time&limit=100'+(after?'&after='+encodeURIComponent(after):''),page.access_token);
   if(!Array.isArray(body.data))throw Error('messages_missing');
   for(const m of body.data){const at=Date.parse(String(m.created_time??''));if(!Number.isFinite(at))throw Error('message_time_missing');if(at>=when&&brandIds.includes(String(m.from?.id))&&m.id)outgoing.push(String(m.id));}
   const oldest=body.data.length?Math.min(...body.data.map((m:any)=>Date.parse(m.created_time))):Infinity;
   if(!body.paging?.next||oldest<when){complete=true;break;}
   const cursor=String(body.paging?.cursors?.after??'');if(!cursor||cursor===after)throw Error('pagination_unavailable');after=cursor;more=true;
  }
  if(!complete)return {reason:'prior_choice_original_pagination_incomplete'};
  // An outgoing message alone cannot prove it is the selected response.
  return {reason:'prior_choice_delivery_unknown',original_outgoing_count:outgoing.length,original_checked_at:new Date().toISOString()};
 }catch{return {reason:'prior_choice_original_unavailable'};}
}
async function verifyOriginalDelivery(env:Env,q:any,plan:any){
 const token=(env as any).META_IG_MESSAGING_TOKEN;if(!token||plan.conversationId!==q.cid)return false;
 try {
  const graph=async(path:string,key:string)=>{const r=await fetch('https://graph.facebook.com/v21.0'+path,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20_000)});const data=await r.json() as any;if(!r.ok||data.error)throw Error('owner_receipt_original_unavailable');return data;};
  const page=await graph('/1697038263872226?fields=access_token',token);if(!page.access_token)return false;
  for(const item of plan.items){
   const original=await graph('/'+encodeURIComponent(String(item.messageId))+'?fields=id,from,created_time',page.access_token);
   if(String(original.id)!==String(item.messageId)||!brandIds.includes(String(original.from?.id)))return false;
   const archived=await env.DB.prepare("SELECT id FROM ugc_ig_messages WHERE id=?1 AND conversation_id=?2 AND direction='out'").bind(String(item.messageId),q.cid).first();
   if(!archived)return false;
  }
  return true;
 }catch{return false;}
}
// Preserve exact Owner choices for processing; a raw callback is not proof
// that its original question was matched or that its action was executed.
export async function collectOwnerChoices(env:Env,roundId:string){
 try {
  const response=await fetch(SOURCE,{signal:AbortSignal.timeout(20_000)});
  const payload=await response.json() as any;
  if(!response.ok||payload.ok!==true||!Array.isArray(payload.items))throw Error('owner_choices_source_unavailable');
  const choices=payload.items.filter((x:any)=>x.agent_slug==='diana-helios'&&x.kind==='callback_query');
  let unresolved=0;
  for(const x of choices){
   const questionId=x.reply_to_message_id??x.message_id;
   // Raw callback records use message_id for the original question. An
   // incomplete record must stay visible rather than disappear from the count.
   if(!questionId||x.update_id==null||!Number.isSafeInteger(Number(x.update_id))){unresolved++;continue;}
   const key='diana_owner_choice:'+String(x.update_id);
   const item:any={status:'needs_review',reason:'original_question_and_action_not_verified',round_id:roundId,update_id:Number(x.update_id),
     reply_to_message_id:String(questionId),choice:String(x.text??'').slice(0,500),source_at:x.created_at??null};
   const question=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('ig_hard:'+String(questionId)).first<{value:string}>();
   const match=String(x.text??'').match(/^opt:\d+:(.+)$/s);
   if(Number(x.handled)!==1)item.reason='owner_callback_not_authenticated_or_handled';
   else if(question&&match){
    let q:any;try{q=JSON.parse(question.value);}catch{}
    const selected=match[1].trim();
    if(q?.options&&Object.prototype.hasOwnProperty.call(q.options,selected)&&(!q.choice||q.choice===selected)){
      // An old recorded selection can have been acted on by the legacy
      // executor without its modern receipt. Inspect original evidence, but
      // never queue it again unless its exact event is still durably pending.
      let priorUnknown=false;
      if(q.decision_at&&!q.answered_at){
        const identity=`owner:${Number(questionId)}:${selected}`;
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity)))].map(v=>v.toString(16).padStart(2,'0')).join('');
        const event='action:'+hash;
        const pending=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_action_pending:'+event).first();
        if(!pending){Object.assign(item,await observeOldChoice(env,q));priorUnknown=true;}
      }
      const action=priorUnknown?null:await answerHardQuestion(env,Number(questionId),selected);
      if(priorUnknown){} // remains needs_review; no external action or replay
      else if(action?.event_id){item.status='queued';item.reason='awaiting_verified_delivery';item.event_id=action.event_id;}
      else if(q.answered_at&&q.options[selected]===null){item.status='verified';item.reason='owner_chose_to_write_personally';}
      else if(q.answered_at&&typeof q.delivery_key==='string'){
        const receipt=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(q.delivery_key).first<{value:string}>();
        let plan:any;try{plan=JSON.parse(receipt?.value??'null');}catch{}
        if(plan?.status==='complete'&&plan.acknowledgedAt&&Array.isArray(plan.items)&&plan.items.length&&plan.items.every((p:any)=>p.status==='sent'&&p.messageId)&&await verifyOriginalDelivery(env,q,plan)){
          item.status='verified';item.reason='owner_choice_delivery_verified';item.delivery_key=q.delivery_key;
        }else item.reason='owner_choice_delivery_unverified';
      }
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
