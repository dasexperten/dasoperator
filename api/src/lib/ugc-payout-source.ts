import type {Env} from '../types';
import {latestRequisites} from './ugc-latest-requisites.mjs';
import {prepareCreatorPayout} from './ugc-payout-intake';
const PAGE='1697038263872226', IG='17841466350261166';
// Narrow, model-free payment intake. No message sends, read-state changes or payment calls.
export async function ingestCreatorPayouts(env:Env){
 const token=(env as unknown as {META_IG_MESSAGING_TOKEN?:string}).META_IG_MESSAGING_TOKEN;
 if(!token)throw Error('payment_source_token_missing');
 async function graph(path:string,key:string):Promise<any>{
  const response=await fetch('https://graph.facebook.com/v21.0/'+path,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20000)});
  const json=await response.json() as any;
  if(!response.ok||json.error)throw Error('payment_source_unavailable');return json;
 }
 const page=await graph(PAGE+'?fields=access_token',token);
 if(!page.access_token)throw Error('payment_source_page_token_missing');
 const now=Date.now(),since=now-14*86400000;let after='',saved=0;
 const failures:string[]=[];
 for(let p=0;p<4;p++){
  const list=await graph(PAGE+'/conversations?platform=instagram&limit=25&fields=id,messages.limit(30){id,created_time,from,message,attachments{mime_type,image_data,file_url}}'+(after?'&after='+encodeURIComponent(after):''),page.access_token);
  for(const c of list.data??[]){
   const rows=(c.messages?.data??[]).filter((m:any)=>Date.parse(m.created_time)>=since).map((m:any)=>({id:String(m.id),conversation_id:String(c.id),direction:String(m.from?.id)===IG||String(m.from?.id)===PAGE?'out':'in',from_id:String(m.from?.id??''),from_username:String(m.from?.username??'').toLowerCase(),text:String(m.message??''),attachments_json:JSON.stringify(m.attachments?.data??[]),created_at:new Date(m.created_time).toISOString()}));
   if(!rows.length)continue;
   await env.DB.batch(rows.map((m:any)=>env.DB.prepare(`INSERT INTO ugc_ig_messages(id,conversation_id,direction,from_id,from_username,text,attachments_json,created_at,seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET text=CASE WHEN ugc_ig_messages.text IS NULL OR ugc_ig_messages.text='' THEN excluded.text ELSE ugc_ig_messages.text END,attachments_json=CASE WHEN ugc_ig_messages.attachments_json IS NULL OR ugc_ig_messages.attachments_json IN ('[]','') THEN excluded.attachments_json ELSE ugc_ig_messages.attachments_json END`).bind(m.id,m.conversation_id,m.direction,m.from_id,m.from_username,m.text,m.attachments_json,m.created_at,new Date(now).toISOString())));
   // Read the original archive, not last-word/read state. An acknowledgement cannot hide requisites.
   const archived=await env.DB.prepare(`SELECT id,direction,text,created_at,from_username FROM ugc_ig_messages WHERE conversation_id=?1 AND created_at>=?2 ORDER BY created_at DESC LIMIT 500`).bind(c.id,new Date(since).toISOString()).all<any>();
   const messages=archived.results??[],r=latestRequisites(messages);
   if(!r)continue;
   const handle=messages.find((m:any)=>m.id===r.cycle_message_id)?.from_username?.toLowerCase();
   if(!handle)continue;
   // Existing 60-day cycle guard: no second payout after a transfer or failed attempt.
   const existing=await env.DB.prepare(`SELECT p.id,p.status,p.execute_claim,p.konsol_payment_id,p.creator_id,p.amount_minor FROM ugc_payouts p JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id WHERE cp.platform='instagram' AND cp.normalized_handle=?1 AND p.created_at>=?2 ORDER BY p.updated_at DESC LIMIT 1`).bind(handle,now-60*86400000).first<any>();
   if(existing&&(existing.execute_claim||existing.konsol_payment_id||!['awaiting_approval','approved'].includes(existing.status)))continue;
   if(existing){
    const receipt=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_payout_intake:'+existing.creator_id).first<{value:string}>();
    if(receipt&&existing.amount_minor!==1&&Number(JSON.parse(receipt.value).source_at)>=r.source_at)continue;
   }
   try{await prepareCreatorPayout(env,{verified:true,handle,conversation_id:c.id,cycle_message_id:r.cycle_message_id,source_message_ids:r.source_message_ids,amount_minor:1,phone:r.phone,first_name:r.first_name,fps_bank_member_id:r.bank,bank_ref:r.bank},now);saved++;}
   catch(error){const code=error instanceof Error?error.message:'intake_failed';if(!/newer_payment_details|already_handed_over|busy_retry/.test(code))failures.push(handle+':'+code);}
  }
  after=list.paging?.cursors?.after??'';if(!list.paging?.next||!after)break;
 }
 if(failures.length)throw Error('payment_intake_failed:'+failures.join(';').slice(0,500));
 return saved;
}
