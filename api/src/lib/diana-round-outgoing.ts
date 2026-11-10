import type {Env} from '../types';

// Match only explicit delivery receipts. An outbound message without one is
// unattributed, not evidence that a human wrote it.
export async function inspectRoundOutgoing(env:Env,creatorId:string,sourceKey:string|null){
 if(!sourceKey?.startsWith('diana/cloud-direct/v1/'))return {status:'needs_review',reason:'outgoing_original_unavailable'};
 try {
  const object=await env.DOCS.get(sourceKey);if(!object)throw Error('outgoing_original_unavailable');
  const source=await object.json() as any;
  if(source.creator?.id!==creatorId||!source.event?.cid||!Array.isArray(source.history))throw Error('outgoing_creator_mismatch');
  const records=await env.DB.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value) AND json_extract(value,'$.conversationId')=?1")
    .bind(source.event.cid).all<{value:string}>();
  const confirmed=new Set<string>();
  for(const row of records.results??[]){
    const record=JSON.parse(row.value);if(!Array.isArray(record.items))throw Error('outgoing_receipt_invalid');
    for(const item of record.items)if(item.status==='sent'&&item.messageId)confirmed.add(String(item.messageId));
  }
  let unknown=0;
  for(const m of source.history){
    if(m.direction!=='out'||!m.id||confirmed.has(String(m.id)))continue;
    unknown++;
    const key=`diana_unattributed_outgoing:${creatorId}:${m.id}`;
    const value={status:'needs_review',reason:'sender_not_proven',creator_id:creatorId,conversation_id:source.event.cid,
      message_id:String(m.id),source_at:m.created_at??null};
    await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,JSON.stringify(value),Date.now()).run();
    if(!await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first())throw Error('outgoing_receipt_not_saved');
  }
  return unknown?{status:'needs_review',reason:'unattributed_outgoing',count:unknown}:{status:'verified',outcome:'all_outgoing_have_delivery_receipts'};
 }catch(error){return {status:'needs_review',reason:String((error as Error)?.message??'outgoing_review_unavailable').slice(0,100)};}
}
