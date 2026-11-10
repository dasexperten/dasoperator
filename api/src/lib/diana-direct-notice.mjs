// Active Direct task adapter. No payment API, no message text stored.
const kinds={payout_paid_notice:'paid',payout_failed_notice:'failed'};
export const isPayoutNotice=e=>!!kinds[e?.task]&&typeof e.payout_id==='string'&&/^action:[a-f0-9]{64}$/.test(e.event_id??'');
async function read(db,key){const r=await db.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first();if(!r)return null;try{return JSON.parse(r.value);}catch{throw Error('notice_corrupt_state');}}
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export async function loadNotice(db,event,{mapProviderStatus,now=Date.now(),maxAgeMs=6*86400000}){
 if(event?.preparePayoutOnly===true)throw Error('notice_prepare_only_forbidden');
 if(!isPayoutNotice(event))throw Error('notice_task_invalid');
 const kind=kinds[event.task];
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`payout:${event.payout_id}:${kind}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(event.event_id!=='action:'+digest)throw Error('notice_identity_invalid');
 const pending=await read(db,'diana_action_pending:'+event.event_id);
 if(!pending||['event_id','cid','payout_id','task','message_id'].some(k=>pending[k]!==event[k]))throw Error('notice_queue_changed');
 if(await read(db,'diana_event_done:'+event.event_id)||await read(db,'diana_payout_notice_verified:'+event.payout_id))throw Error('notice_already_resolved');
 const p=await db.prepare('SELECT * FROM ugc_payouts WHERE id=?1').bind(event.payout_id).first();
 if(!p||p.status!==kind||!p.konsol_payment_id||mapProviderStatus(p.konsol_status)!==kind)throw Error('notice_provider_not_confirmed');
 if(['delivered','reviewed','sending'].includes(p.notice_status)||p.notice_message_id)throw Error('notice_already_resolved');
 const at=kind==='paid'?p.paid_at:p.failed_at;
 if(!time(at)||Date.parse(at)>now||now-Date.parse(at)>maxAgeMs)throw Error('notice_timestamp_requires_review');
 if(pending.konsol_payment_id!==p.konsol_payment_id||pending.status!==p.status||pending[kind+'_at']!==at||pending.amount_minor!==p.amount_minor||pending.currency!==p.currency)throw Error('notice_payout_changed');
 const legacy=await db.prepare("SELECT 1 AS present FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.actionId')=?1 ELSE 1 END LIMIT 1").bind(event.event_id).first();
 if(legacy)return Promise.reject(Error('notice_legacy_delivery_review'));
 return {id:p.id,kind,provider_id:p.konsol_payment_id,provider_status:p.konsol_status,at,amount_minor:p.amount_minor,currency:p.currency,handle:p.handle,updated_at:p.updated_at};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function runPayoutNotice({db,event,workflowId,mapProviderStatus,readOriginal,decideNotice,sendAndVerify,now=Date.now()}){
 // Existing shared lock prevents a Diana Round/old Direct writer overlapping.
 const owner=await read(db,'diana_cloud_execution_lock');
 if(owner?.kind!=='direct'||owner.id!==workflowId)throw Error('notice_execution_lock_required');
 const snapshot=await loadNotice(db,event,{mapProviderStatus,now});
 const source=await readOriginal(event.cid); // current full dialogue, not the old queue message
 if(source?.status!=='ready'||source.conversationId!==event.cid||typeof source.recipientId!=='string'||!source.recipientId||typeof source.latestId!=='string'||!source.latestId)throw Error('notice_current_original_required');
 if(String(source.handle).replace(/^@/,'').toLowerCase()!==String(snapshot.handle).replace(/^@/,'').toLowerCase())throw Error('notice_recipient_mismatch');
 const decision=await decideNotice({source,payout:snapshot,task:event.task});
 if(decision?.action!=='reply'||typeof decision.reply!=='string'||!decision.reply.trim())return {status:'pending',reason:'notice_owner_review'};
 if(!same(snapshot,await loadNotice(db,event,{mapProviderStatus,now:Date.now()})))throw Error('notice_payout_changed');
 const key='diana_direct_notice_delivery:'+event.event_id;
 const claim=await db.prepare("INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM crm_sync_state WHERE key='diana_cloud_execution_lock' AND json_valid(value) AND json_extract(value,'$.kind')='direct' AND json_extract(value,'$.id')=?4)").bind(key,JSON.stringify({status:'claimed',event_id:event.event_id,payout_id:snapshot.id,provider_id:snapshot.provider_id}),Date.now(),workflowId).run();
 if(!claim.meta?.changes)return {status:'pending',reason:'notice_claim_exists_reconcile_only'};
 let delivery;
 try{
  // Sender MUST recheck exact latestId/recipient before POST and verify Meta
  // outgoing receipt text/id/brand/time. It MUST use task event identity, not
  // normal incoming-message dedup. This is trusted code, not request flags.
  delivery=await sendAndVerify({conversationId:event.cid,recipientId:source.recipientId,latestId:source.latestId,text:decision.reply,actionId:event.event_id,windowMessageId:source.windowMessageId,beforeSend:async()=>{if(!same(snapshot,await loadNotice(db,event,{mapProviderStatus,now:Date.now()})))throw Error('notice_payout_changed');const held=await read(db,'diana_cloud_execution_lock');if(held?.kind!=='direct'||held.id!==workflowId)throw Error('notice_execution_lock_changed');}});
  if(delivery?.status==='not_sent'){
   await db.prepare("UPDATE crm_sync_state SET value=json_set(value,'$.status','not_sent'),updated_at=?2 WHERE key=?1 AND json_extract(value,'$.status')='claimed'").bind(key,Date.now()).run();
   return {status:'pending',reason:'notice_not_sent_requires_review'};
  }
  if(delivery?.status!=='verified'||!delivery.outgoingId||!time(delivery.sentAt)||Date.parse(delivery.sentAt)<Date.parse(snapshot.at)||Date.parse(delivery.sentAt)>Date.now())throw Error('notice_delivery_unconfirmed');
  const proof=JSON.stringify({verified:true,event_id:event.event_id,cid:event.cid,message_id:event.message_id,payout_id:snapshot.id,outgoing_id:delivery.outgoingId,sent_at:delivery.sentAt,provider_id:snapshot.provider_id,proof:'Meta outgoing readback',outcome:'delivered'});
  // Provider outcome/time/amount snapshot is checked again atomically. If it
  // changed after send, preserve claim for reconciliation, never resend.
  const results=await db.batch([
   db.prepare("UPDATE ugc_payouts SET notice_status='delivered',notice_message_id=?2,notice_at=?3,paid_notice_at=?3,updated_at=?4 WHERE id=?1 AND status=?5 AND konsol_payment_id=?6 AND konsol_status IS ?7 AND amount_minor=?8 AND currency=?9 AND updated_at=?10 AND (CASE WHEN status='paid' THEN paid_at ELSE failed_at END)=?11 AND COALESCE(notice_status,'') NOT IN('delivered','reviewed') AND notice_message_id IS NULL").bind(snapshot.id,delivery.outgoingId,delivery.sentAt,Date.now(),snapshot.kind,snapshot.provider_id,snapshot.provider_status,snapshot.amount_minor,snapshot.currency,snapshot.updated_at,snapshot.at),
   db.prepare("INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM ugc_payouts WHERE id=?4 AND notice_status='delivered' AND notice_message_id=?5) ON CONFLICT(key) DO NOTHING").bind('diana_event_done:'+event.event_id,proof,Date.now(),snapshot.id,delivery.outgoingId),
   db.prepare("UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND EXISTS(SELECT 1 FROM ugc_payouts WHERE id=?4 AND notice_status='delivered' AND notice_message_id=?5)").bind(key,JSON.stringify({status:'verified',outgoing_id:delivery.outgoingId,event_id:event.event_id,payout_id:snapshot.id}),Date.now(),snapshot.id,delivery.outgoingId)
  ]);
  if(!results[0].meta?.changes)throw Error('notice_payout_changed_after_send');
  return {status:'complete',outgoing_id:delivery.outgoingId};
 }catch{
  await db.prepare("UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'").bind(key,JSON.stringify({status:'unknown',event_id:event.event_id,payout_id:snapshot.id,...(delivery?.outgoingId?{outgoing_id:delivery.outgoingId}:{})}),Date.now()).run();
  return {status:'pending',reason:'notice_delivery_reconcile_only'};
 }
}
