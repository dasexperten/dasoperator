// Trusted notice adapters. No archive, model, payment or HUMAN_AGENT exception.
const PAGE='1697038263872226',BRAND='17841466350261166',ROOT='https://graph.facebook.com/v21.0/';
const ours=id=>[PAGE,BRAND].includes(String(id));
const id=v=>typeof v==='string'&&v.length>0&&v.length<2049&&!/[\s\x00-\x1f]/u.test(v);
function graph(token,fetchImpl){return async path=>{const r=await fetchImpl(ROOT+path,{method:'GET',headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('notice_meta_read_unavailable');const body=await r.json();if(body?.error)throw Error('notice_meta_read_unavailable');return body;};}
async function access(token,fetchImpl){if(!token)throw Error('notice_token_missing');const p=await graph(token,fetchImpl)(PAGE+'?fields=access_token');if(!p.access_token)throw Error('notice_page_access_missing');return p.access_token;}
export async function readNoticeOriginal({conversationId,token,fetchImpl=fetch}){
 if(!id(conversationId))throw Error('notice_conversation_invalid');
 const read=graph(await access(token,fetchImpl),fetchImpl);const all=[],cursors=new Set();let after='';
 for(let page=0;page<100;page++){
  const body=await read(encodeURIComponent(conversationId)+'/messages?fields=id,created_time,from,message,is_unsupported,shares{link},attachments{mime_type,file_url,image_data,video_data}&limit=100'+(after?'&after='+encodeURIComponent(after):''));
  if(!Array.isArray(body.data))throw Error('notice_original_incomplete');all.push(...body.data);
  if(!body.paging?.next){after='';break;}
  const next=body.paging?.cursors?.after;if(!next||cursors.has(next)||!body.data.length)throw Error('notice_original_incomplete');cursors.add(next);after=next;
 }
 if(after||!all.length)throw Error('notice_original_incomplete');
 const incoming=all.filter(m=>m.from?.id&&!ours(m.from.id));const sender=incoming[0];
 if(!sender||new Set(incoming.map(m=>String(m.from.id))).size!==1||!id(String(all[0].id??''))||!id(String(sender.id??''))||!Number.isFinite(Date.parse(sender.created_time)))throw Error('notice_sender_identity_unavailable');
 const handle=incoming.find(m=>m.from?.username)?.from.username;
 if(typeof handle!=='string'||!/^@?[a-z0-9_.]{1,30}$/iu.test(handle))throw Error('notice_sender_handle_unavailable');
 return {status:'ready',conversationId,latestId:String(all[0].id),recipientId:String(sender.from.id),handle:handle.replace(/^@/,'').toLowerCase(),windowMessageId:String(sender.id),latestIncomingAt:sender.created_time,messages:all.reverse()};
}
export async function sendNoticeAndVerify({db,conversationId,recipientId,latestId,windowMessageId,text,actionId,beforeSend,token,fetchImpl=fetch,now=Date.now()}){
 if(!db||![conversationId,recipientId,latestId,windowMessageId].every(id)||!/^action:[a-f0-9]{64}$/.test(actionId??'')||typeof text!=='string'||!text.trim()||typeof beforeSend!=='function')throw Error('notice_send_input_invalid');
 const key='diana_direct_notice_delivery:'+actionId;const pageToken=await access(token,fetchImpl),read=graph(pageToken,fetchImpl);
 const latest=async()=>{const p=await read(encodeURIComponent(conversationId)+'/messages?fields=id,from&limit=1');return p?.data?.[0];};
 const current=await latest();if(String(current?.id??'')!==latestId)return {status:'not_sent',reason:'notice_conversation_changed'};
 const window=await read(encodeURIComponent(windowMessageId)+'?fields=id,from,created_time');const at=Date.parse(window?.created_time);
 if(String(window?.id??'')!==windowMessageId||String(window?.from?.id??'')!==recipientId||ours(recipientId)||!Number.isFinite(at)||at>now||now-at>=86400000)return {status:'not_sent',reason:'notice_outside_response_window'};
 // Claim belongs to the action, never to an unrelated latest incoming event.
 const claim=await db.prepare("UPDATE crm_sync_state SET value=json_set(value,'$.status','sending','$.conversation_id',?3,'$.recipient_id',?4,'$.latest_id',?5),updated_at=?6 WHERE key=?1 AND json_valid(value) AND json_extract(value,'$.status')='claimed' AND json_extract(value,'$.event_id')=?2")
  .bind(key,actionId,conversationId,recipientId,latestId,now).run();
 if(!claim.meta?.changes)return {status:'not_sent',reason:'notice_claim_not_owned'};
 const settle=async(status,extra={})=>db.prepare("UPDATE crm_sync_state SET value=json_patch(value,?2),updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='sending'").bind(key,JSON.stringify({status,...extra}),Date.now()).run();
 let outgoingId;
 try{
  // Revalidate provider state/shared lock and exact newest original immediately
  // before send. No boolean provided by an external caller is accepted.
  await beforeSend();if(Date.now()-at>=86400000){await settle('not_sent',{reason:'response_window_expired'});return {status:'not_sent',reason:'notice_outside_response_window'};}const check=await latest();if(String(check?.id??'')!==latestId){await settle('not_sent',{reason:'conversation_changed'});return {status:'not_sent',reason:'notice_conversation_changed'};}
  const response=await fetchImpl(ROOT+PAGE+'/messages',{method:'POST',headers:{authorization:'Bearer '+pageToken,'content-type':'application/json'},redirect:'error',body:JSON.stringify({recipient:{id:recipientId},message:{text},messaging_type:'RESPONSE'}),signal:AbortSignal.timeout(20000)});
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload?.message_id){
   const knownRejection=response.status>=400&&response.status<500&&!payload?.message_id&&Number.isFinite(payload?.error?.code)&&/allowed window|invalid (?:parameter|oauth|access token)|(?:access token).*(?:expired|invalid)|permission|not authorized|not receiving messages|isn't available|no matching user|rate limit|too many requests/i.test(String(payload?.error?.message??''));
   await settle(knownRejection?'not_sent':'unknown');return {status:knownRejection?'not_sent':'unknown',reason:'notice_meta_rejected_or_unconfirmed'};
  }
  outgoingId=String(payload.message_id);const proof=await read(encodeURIComponent(outgoingId)+'?fields=id,from,message,created_time');
  const sent=Date.parse(proof?.created_time);
  if(String(proof?.id??'')!==outgoingId||!ours(proof?.from?.id)||proof.message!==text||!Number.isFinite(sent)||sent> Date.now())throw Error('notice_readback_invalid');
  const saved=await settle('verified',{outgoing_id:outgoingId,sent_at:new Date(sent).toISOString()});if(!saved.meta?.changes)throw Error('notice_receipt_conflict');
  return {status:'verified',outgoingId,sentAt:new Date(sent).toISOString()};
 }catch{await settle('unknown',outgoingId?{outgoing_id:outgoingId}:{});return {status:'unknown',reason:'notice_send_or_readback_unconfirmed'};}
}
