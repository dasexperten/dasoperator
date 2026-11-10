import type {Env} from '../types';
import {sendOwnerQuestion} from './owner-telegram';

type ReviewEvent={cid:string;message_id:string;event_id:string;handle?:string;at:string;dryRun?:boolean};
// A safe, non-committal draft: it does not assert a sender, transfer, term,
// product claim or content of an unavailable attachment.
const DRAFT='Спасибо за сообщение! Я уточню детали и вернусь с ответом.';
export async function prepareReviewPlan(env:Env,event:ReviewEvent,outcome:{reason?:string}){
 if(event.dryRun)return {status:'preview'};
 const key='diana_review_plan:'+event.event_id,intentKey='diana_review_owner_intent:'+event.event_id;
 const sensitive=/delivery|sent|send|payment|payout|claim|receipt|unknown/i.test(String(outcome.reason??''));
 const options:Record<string,string[]|null>=sensitive?{'Проверю сам':null}:{'Отправить черновик':[DRAFT],'Напишу сам':null};
 const plan={version:1,status:'prepared',event_id:event.event_id,message_id:event.message_id,conversation_id:event.cid,handle:event.handle??null,at:event.at,
  reason:String(outcome.reason??'review_required').slice(0,200),draft:DRAFT,options,next:sensitive?'inspect_original_and_payment_receipts':'owner_choice'};
 await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,JSON.stringify(plan),Date.now()).run();
 const existing=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
 if(!existing)throw Error('review_plan_not_saved');
 let saved:any;try{saved=JSON.parse(existing.value);}catch{throw Error('review_plan_invalid');}
 if(saved.event_id!==event.event_id||saved.message_id!==event.message_id||saved.conversation_id!==event.cid)throw Error('review_plan_identity_mismatch');
 if(!env.ORGANIZATION||!env.DASORG_API_KEY||!/^[a-z0-9_.]{1,30}$/i.test(String(saved.handle??'')))return {status:'prepared',reason:'owner_route_unavailable'};
 const marker=JSON.stringify({status:'sending',event_id:event.event_id,at:Date.now()});
 const claimed=await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(intentKey,marker,Date.now()).run();
 if(!claimed.meta.changes)return {status:'already_attempted'};
 const text=`Диане нужно решение по @${saved.handle}.\n\nПодготовленный нейтральный ответ: ${saved.draft}\n\nОткройте исходную переписку и выберите действие: https://erp.dasexperten.com/ugc?search=${encodeURIComponent(saved.handle)}`;
 const questionId=await sendOwnerQuestion(env,text,Object.keys(saved.options));
 if(questionId==null){await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind(intentKey,JSON.stringify({status:'delivery_unknown',event_id:event.event_id,reason:'owner_question_not_confirmed',at:Date.now()}),Date.now(),marker).run();return {status:'delivery_unknown'};}
 const question={cid:event.cid,handle:saved.handle,at:event.at,options:saved.options,review_event_id:event.event_id};
 await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind('ig_hard:'+questionId,JSON.stringify(question),Date.now()).run();
 const check=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('ig_hard:'+questionId).first<{value:string}>();
 if(check?.value!==JSON.stringify(question))throw Error('owner_question_identity_conflict');
 await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind(intentKey,JSON.stringify({status:'sent',event_id:event.event_id,question_id:String(questionId),at:Date.now()}),Date.now(),marker).run();
 return {status:'sent',question_id:String(questionId)};
}
