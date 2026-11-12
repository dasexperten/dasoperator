// No message content is persisted. A claimed delivery is never replayed when
// the result is unknown; its original Meta receipt is the only completion proof.
const PAGE='1697038263872226', BRAND='17841466350261166';
const ROOT='https://graph.facebook.com/v21.0/';
const keyFor=(cid,messageId)=>`diana_direct_delivery:${cid}:${messageId}`;

export async function deliverDirectReply({db,conversationId,messageId,recipientId,text,token,fetchImpl=fetch,now=Date.now(),followTexts=[],images=[]}) {
  if(!db||!conversationId||!messageId||!recipientId||!token||typeof text!=='string'||!text.trim())throw Error('direct_delivery_invalid');
  const headers={authorization:`Bearer ${token}`};
  async function get(path,key=token){
    const r=await fetchImpl(ROOT+path,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error(`direct_meta_read_${r.status}`);return r.json();
  }
  const page=await get(`${PAGE}?fields=access_token`);if(!page.access_token)throw Error('direct_page_token_missing');
  const latest=await get(`${encodeURIComponent(conversationId)}/messages?fields=id,from,created_time&limit=1`,page.access_token);
  const original=latest?.data?.[0];
  if(String(original?.id??'')!==String(messageId)||String(original?.from?.id??'')!==String(recipientId)||[PAGE,BRAND].includes(String(original?.from?.id??'')))return {status:'superseded'};
  if(!Number.isFinite(Date.parse(String(original.created_time??''))))throw Error('direct_original_time_missing');
  // Historical delivery plans can contain a send in flight or already sent.
  // Check their metadata without loading or copying their message content.
  const legacy=await db.prepare(`SELECT 1 AS present FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%' AND json_valid(value)
    AND json_extract(value,'$.conversationId')=?1 AND julianday(json_extract(value,'$.incomingAt'))=julianday(?2) LIMIT 1`)
    .bind(conversationId,original.created_time).first();
  if(legacy)return {status:'legacy_delivery_review'};
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
    const post=extra=>fetchImpl(ROOT+`${PAGE}/messages`,{method:'POST',headers:{...headers,authorization:`Bearer ${page.access_token}`,'content-type':'application/json'},
      body:JSON.stringify({recipient:{id:String(recipientId)},message:{text},...extra}),signal:AbortSignal.timeout(20000)});
    let response=await post({messaging_type:'RESPONSE'});
    let payload=await response.json().catch(()=>null);
    // Owner 2026-11-11: no chat stays unanswered. Past Instagram's 24-hour window a
    // human-agent tagged reply is allowed for 7 days; Meta itself refuses beyond that.
    if(!response.ok&&[400,403].includes(response.status)){response=await post({messaging_type:'MESSAGE_TAG',tag:'HUMAN_AGENT'});payload=await response.json().catch(()=>null);}
    if(!response.ok||!payload?.message_id)throw Error('direct_delivery_unconfirmed');
    outgoing=String(payload.message_id);
    const proof=await get(`${encodeURIComponent(outgoing)}?fields=id,message,from`,page.access_token);
    if(String(proof?.id??'')!==outgoing||proof?.message!==text||![PAGE,BRAND].includes(String(proof?.from?.id??'')))throw Error('direct_delivery_unconfirmed');
    // Owner 2026-11-12 (argnvd): the four approved scenario cards go as the follow-up of the
    // verified first line: the second short line, then each card picture, in order.
    const extra=[];
    for(const item of [...followTexts.map(t=>({text:t})),...images.map(url=>({url}))]){
      const body=item.url?{attachment:{type:'image',payload:{url:item.url,is_reusable:true}}}:{text:item.text};
      const send=tag=>fetchImpl(ROOT+`${PAGE}/messages`,{method:'POST',headers:{authorization:`Bearer ${page.access_token}`,'content-type':'application/json'},
        body:JSON.stringify({recipient:{id:String(recipientId)},message:body,...tag}),signal:AbortSignal.timeout(30000)});
      let r=await send({messaging_type:'RESPONSE'});let j=await r.json().catch(()=>null);
      if(!r.ok&&[400,403].includes(r.status)){r=await send({messaging_type:'MESSAGE_TAG',tag:'HUMAN_AGENT'});j=await r.json().catch(()=>null);}
      if(!r.ok||!j?.message_id)throw Error('direct_delivery_unconfirmed');
      extra.push(String(j.message_id));
    }
    const saved=await db.prepare(`UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'`)
      .bind(key,JSON.stringify({status:'verified',conversation_id:conversationId,incoming_id:messageId,outgoing_id:outgoing,...(extra.length?{follow_ids:extra}:{}),at:now}),Date.now()).run();
    if(!saved?.meta?.changes)throw Error('direct_delivery_state_conflict');
    return {status:'verified',outgoingId:outgoing};
  }catch{
    await db.prepare(`UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND json_extract(value,'$.status')='claimed'`)
      .bind(key,JSON.stringify({status:'unknown',conversation_id:conversationId,incoming_id:messageId,...(outgoing?{outgoing_id:outgoing}:{}),at:now}),Date.now()).run();
    return {status:'unknown'};
  }
}
