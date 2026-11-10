import type {Env} from '../types';
import {latestRequisites} from './ugc-latest-requisites.mjs';
import {reviewPayoutCart,payoutImagePolicy} from './ugc-cart-review';
import {prepareCreatorPayout} from './ugc-payout-intake';
const PAGE='1697038263872226', IG='17841466350261166';
const BANK_LABELS:Record<string,string>={'100000000111':'Сбербанк','100000000004':'Т-Банк','100000000005':'ВТБ','100000000273':'Озон Банк','100000000008':'Альфа-Банк','100000000007':'Райффайзенбанк','100000000001':'Газпромбанк','100000000013':'Совкомбанк','100000000017':'МТС Банк','100000000016':'Почта Банк','100000000012':'Росбанк','100000000150':'Яндекс Банк','100000000015':'Открытие','100000000026':'Уралсиб','100000000020':'Россельхозбанк'};
// Original-message intake with subscription image review; no replies, read marks or payment calls.
export async function ingestCreatorPayouts(env:Env, target?:{conversation_id:string;message_id:string;phone:string;bank:string;first_name:string;amount_minor:number;originals:{id:string;direction:string;text:string}[]}){
 const token=(env as unknown as {META_IG_MESSAGING_TOKEN?:string}).META_IG_MESSAGING_TOKEN;
 if(!token)throw Error('payment_source_token_missing');
 async function graph(path:string,key:string):Promise<any>{
  const response=await fetch('https://graph.facebook.com/v21.0/'+path,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20000)});
  const json=await response.json() as any;
  if(!response.ok||json.error)throw Error('payment_source_unavailable');return json;
 }
 const page=await graph(PAGE+'?fields=access_token',token);
 if(!page.access_token)throw Error('payment_source_page_token_missing');
 const now=Date.now(),since=now-14*86400000;let after='',saved=0;let savedId:string|undefined;
 const failures:string[]=[];
 const recognitionBudget={remaining:3};let imagePolicy:ReturnType<typeof payoutImagePolicy>|undefined;
 const policy=()=>imagePolicy??=payoutImagePolicy(env);
 for(let p=0;p<(target?1:4);p++){
  const fields='id,messages.limit(30){id,created_time,from,message,attachments{mime_type,image_data,file_url}}';
  const list=target?{data:[await graph(encodeURIComponent(target.conversation_id)+'?fields='+fields,page.access_token)]}:
    await graph(PAGE+'/conversations?platform=instagram&limit=25&fields='+fields+(after?'&after='+encodeURIComponent(after):''),page.access_token);
  for(const c of list.data??[]){
   if(target&&String(c.id)!==target.conversation_id)throw Error('payment_source_conversation_mismatch');
   const rows=(c.messages?.data??[]).filter((m:any)=>Date.parse(m.created_time)>=since).map((m:any)=>({id:String(m.id),conversation_id:String(c.id),direction:String(m.from?.id)===IG||String(m.from?.id)===PAGE?'out':'in',from_id:String(m.from?.id??''),from_username:String(m.from?.username??'').toLowerCase(),text:String(m.message??''),attachments_json:JSON.stringify(m.attachments?.data??[]),created_at:new Date(m.created_time).toISOString()}));
   if(target){
    const latest=[...rows].sort((a:any,b:any)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
    if(!latest||latest.direction!=='in'||latest.id!==target.message_id)throw Error('payout_conversation_changed');
   }
   if(!rows.length)continue;
   await env.DB.batch(rows.map((m:any)=>env.DB.prepare(`INSERT INTO ugc_ig_messages(id,conversation_id,direction,from_id,from_username,text,attachments_json,created_at,seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET text=CASE WHEN ugc_ig_messages.text IS NULL OR ugc_ig_messages.text='' THEN excluded.text ELSE ugc_ig_messages.text END,attachments_json=CASE WHEN ugc_ig_messages.attachments_json IS NULL OR ugc_ig_messages.attachments_json IN ('[]','') THEN excluded.attachments_json ELSE ugc_ig_messages.attachments_json END`).bind(m.id,m.conversation_id,m.direction,m.from_id,m.from_username,m.text,m.attachments_json,m.created_at,new Date(now).toISOString())));
   // Read the original archive, not last-word/read state. An acknowledgement cannot hide requisites.
   const archived=await env.DB.prepare(`SELECT id,direction,text,created_at,from_username,attachments_json FROM ugc_ig_messages WHERE conversation_id=?1 AND created_at>=?2 ORDER BY created_at DESC LIMIT 500`).bind(c.id,new Date(since).toISOString()).all<any>();
   const messages=archived.results??[],r=latestRequisites(messages);
   if(!r){if(target)throw Error('diana_payout_original_requisites_missing');continue;}
   if(target && (!r.source_message_ids.includes(target.message_id) || r.phone.replace(/\D/g,'')!==target.phone.replace(/\D/g,'') ||
      r.bank!==target.bank || r.first_name.trim().toLocaleLowerCase()!==target.first_name.trim().toLocaleLowerCase()))
     throw Error('diana_payout_facts_do_not_match_original');
   if(target && r.source_message_ids.some((id:string)=>{
    const original=target.originals.find(m=>m.id===id),archived=messages.find((m:any)=>m.id===id);
    return !original||original.direction!=='in'||!archived||archived.direction!=='in'||original.text!==archived.text;
   }))throw Error('diana_payout_original_archive_mismatch');
   const handle=messages.find((m:any)=>m.id===r.cycle_message_id)?.from_username?.toLowerCase();
   if(!handle)continue;
   // Existing 60-day cycle guard: no second payout after a transfer or failed attempt.
   const existing=await env.DB.prepare(`SELECT p.id,p.status,p.execute_claim,p.konsol_payment_id,p.creator_id,p.amount_minor FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.created_at>=?2 ORDER BY p.updated_at DESC LIMIT 1`).bind(handle,now-60*86400000).first<any>();
   if(existing&&(existing.execute_claim||existing.konsol_payment_id||!['awaiting_approval','approved'].includes(existing.status)))continue;
   let observedAmount=existing?.amount_minor>=5000?existing.amount_minor:1;
   // Never replace an Owner-entered amount. Unconfirmed/new payouts get source recognition first.
   if(target||!existing||existing.amount_minor<5000){
    try{const review=await reviewPayoutCart(env,c.id,messages,{budget:recognitionBudget,policy,now});
      if(target&&(review.status!=='confirmed'||!review.amount_minor))throw Error('current_cart_not_confirmed');
      if(review.status==='confirmed'&&review.amount_minor){
        if(target&&existing?.amount_minor>=5000&&existing.amount_minor!==review.amount_minor)throw Error('existing_amount_differs_from_current_cart');
        observedAmount=review.amount_minor;
      }}
    catch{
      failures.push(handle+':cart_recognition_pending');
      await env.DB.batch([env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('ugc_cart_review_error:'+c.id,JSON.stringify({status:'pending',reason:'recognition_unavailable',checked_at:now}),now)]);
      continue;
    }
   }
   if(target && observedAmount!==target.amount_minor)throw Error('diana_payout_amount_not_verified');
   if(existing){
    const receipt=await env.DB.prepare('SELECT value,updated_at FROM crm_sync_state WHERE key=?1').bind('diana_payout_intake:'+existing.creator_id).first<{value:string;updated_at:number}>();
    if(receipt&&Number(JSON.parse(receipt.value).source_at)>=r.source_at){
     const context=existing.amount_minor<5000?await env.DB.prepare('SELECT updated_at FROM crm_sync_state WHERE key=?1').bind('diana_context:'+c.id).first<{updated_at:number}>():null;
     const cart=existing.amount_minor<5000?await env.DB.prepare('SELECT updated_at FROM crm_sync_state WHERE key=?1').bind('ugc_cart_review:'+c.id).first<{updated_at:number}>():null;
     if(!target&&(!context||context.updated_at<=receipt.updated_at)&&(!cart||cart.updated_at<=receipt.updated_at))continue;
    }
   }
   try{const result=await prepareCreatorPayout(env,{verified:true,handle,conversation_id:c.id,cycle_message_id:r.cycle_message_id,source_message_ids:r.source_message_ids,amount_minor:observedAmount,phone:r.phone,first_name:r.first_name,fps_bank_member_id:r.bank,bank_ref:BANK_LABELS[r.bank]??r.bank},now);if(result.registered!==false){saved++;savedId=String(result.id??'');}}
   catch(error){const code=error instanceof Error?error.message:'intake_failed';if(target)throw Error('diana_payout_intake_'+code);if(!/newer_payment_details|already_handed_over|busy_retry/.test(code))failures.push(handle+':'+code);}
  }
  after=list.paging?.cursors?.after??'';if(!list.paging?.next||!after)break;
 }
 if(failures.length)throw Error('payment_intake_failed:'+failures.join(';').slice(0,500));
 return target?{registered:saved,payout_id:savedId||null}:saved;
}
