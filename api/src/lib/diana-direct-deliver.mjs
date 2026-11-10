// No message content is persisted. A claimed delivery is never replayed when
// the result is unknown; its original Meta receipt is the only completion proof.
const PAGE='1697038263872226', BRAND='17841466350261166';
const ROOT='https://graph.facebook.com/v21.0/';
const keyFor=(cid,messageId)=>`diana_direct_delivery:${cid}:${messageId}`;

export async function deliverDirectReply({db,conversationId,messageId,recipientId,text,token,fetchImpl=fetch,now=Date.now()}) {
  if(!db||!conversationId||!messageId||!recipientId||!token||typeof text!=='string'||!text.trim())throw Error('direct_delivery_invalid');
  const headers={authorization:`Bearer ${token}`};
  async function get(path,key=token){
    const r=await fetchImpl(ROOT+path,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error(`direct_meta_read_${r.status}`);return r.json();
  }
  const page=await get(`${PAGE}?fields=access_token`);if(!page.access_token)throw Error('direct_page_token_missing');
  const latest=await get(`${encodeURIComponent(conversationId)}/messages?fields=id,from&limit=1`,page.access_token);
  const original=latest?.data?.[0];
  if(String(original?.id??'')!==String(messageId)||String(original?.from?.id??'')!==String(recipientId)||[PAGE,BRAND].includes(String(original?.from?.id??'')))return {status:'superseded'};
  const key=keyFor(conversationId,messageId);
  const claim=await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind(key,JSON.stringify({status:'claimed',conversation_id:conversationId,incoming_id:messageId,at:now}),now).run();
  if(!claim?.meta?.changes)return {status:'already_claimed'};
  let outgoing;
  try{
    const recheck=await get(`${encodeURIComponent(conversationId)}/messages?fields=id,from&limit=1`,page.access_token);
    const current=recheck?.data?.[0];
    if(String(current?.id??'')!==String(messageId)||String(current?.from?.id??'')!==String(recipientId)){
      await db.prepare(`UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'`)
        .bind(key,JSON.stringify({status:'superseded',conversation_id:conversationId,incoming_id:messageId,at:now}),Date.now()).run();
      return {status:'superseded'};
    }
    const response=await fetchImpl(ROOT+`${PAGE}/messages`,{method:'POST',headers:{...headers,authorization:`Bearer ${page.access_token}`,'content-type':'application/json'},
      body:JSON.stringify({recipient:{id:String(recipientId)},message:{text},messaging_type:'RESPONSE'}),signal:AbortSignal.timeout(20000)});
    const payload=await response.json().catch(()=>null);
    if(!response.ok||!payload?.message_id)throw Error('direct_delivery_unconfirmed');
    outgoing=String(payload.message_id);
    const proof=await get(`${encodeURIComponent(outgoing)}?fields=id,message,from`,page.access_token);
    if(String(proof?.id??'')!==outgoing||proof?.message!==text||![PAGE,BRAND].includes(String(proof?.from?.id??'')))throw Error('direct_delivery_unconfirmed');
    const saved=await db.prepare(`UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'`)
      .bind(key,JSON.stringify({status:'verified',conversation_id:conversationId,incoming_id:messageId,outgoing_id:outgoing,at:now}),Date.now()).run();
    if(!saved?.meta?.changes)throw Error('direct_delivery_state_conflict');
    return {status:'verified',outgoingId:outgoing};
  }catch{
    await db.prepare(`UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'`)
      .bind(key,JSON.stringify({status:'unknown',conversation_id:conversationId,incoming_id:messageId,...(outgoing?{outgoing_id:outgoing}:{}),at:now}),Date.now()).run();
    return {status:'unknown'};
  }
}
