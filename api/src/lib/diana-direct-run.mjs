// Orchestrates one signal in memory. Do not return messages or decisions from
// a Workflow step: Cloudflare persists step results. Only status and IDs leave.
export async function runDirect({event,readOriginal,decide,handoffPayout,deliver,deliverCards,saveProof,acknowledge,pendingAmount}) {
  const source=await readOriginal({conversationId:event.cid,messageId:event.message_id});
  if(source.status!=='ready')return {status:'superseded'};
  const decision=await decide(source);
  if(decision.action==='payout' && !event.dryRun && typeof handoffPayout==='function') {
    // This callback only prepares an Owner-approval row. Never submit a transfer,
    // send a confirmation or mark the incoming message as answered here.
    const handoff=await handoffPayout({event,source});
    if(handoff?.status==='registered') {
      if(typeof handoff.payout_id!=='string'||!handoff.payout_id||!Number.isSafeInteger(handoff.amount_minor)||handoff.amount_minor<=0)
        throw Error('direct_payout_receipt_invalid');
      return {status:'prepared',reason:'payout_awaiting_owner',payout_id:handoff.payout_id,amount_minor:handoff.amount_minor};
    }
    if(handoff?.status==='registered_without_amount') {
      // Owner 11.11.2026: the button already stands; one simple question asks for the amount.
      if(typeof handoff.payout_id!=='string'||!handoff.payout_id)throw Error('direct_payout_receipt_invalid');
      if(!decision.amountQuestion||!decision.recipientId)return {status:'pending',reason:'payout_amount_question_missing',payout_id:handoff.payout_id};
      const asked=await deliver({conversationId:event.cid,messageId:event.message_id,recipientId:decision.recipientId,text:decision.amountQuestion});
      if(asked.status==='preview')return {status:'preview',payout_id:handoff.payout_id};
      if(asked.status!=='verified')return {status:'pending',reason:'delivery_'+asked.status,payout_id:handoff.payout_id};
      await saveProof({event_id:event.event_id,cid:event.cid,message_id:event.message_id,verified:true,proof:'Original Meta outgoing receipt read back',outgoing_id:asked.outgoingId,executor:'diana_direct_workflow',payout_id:handoff.payout_id});
      const acknowledged=await acknowledge(event);
      return acknowledged?{status:'complete',reason:'payout_button_amount_asked',payout_id:handoff.payout_id,outgoing_id:asked.outgoingId}:{status:'pending',reason:'newer_event_preserved'};
    }
    if(handoff?.status==='incomplete')return {status:'pending',reason:'payout_missing_fields'};
    return {status:'pending',reason:'payout_verification_pending'};
  }
  // Owner 11.11.2026: a button waiting for its amount is filled the moment the
  // creator writes it, before Diana's ordinary reply. Silent; never a transfer.
  let backed=null;
  if(decision.action==='reply'&&!event.dryRun&&typeof handoffPayout==='function'&&typeof pendingAmount==='function'&&await pendingAmount(source)){
    try{const h=await handoffPayout({event,source});backed=['registered','registered_without_amount'].includes(h?.status);}catch{backed=false;}
  }
  // Owner 2026-11-11: Diana never says the details are received or the transfer is being
  // prepared while no button stands. The chat stays visible instead of a false promise.
  if(decision.action==='reply'&&backed===false&&/реквизит\S*\s+получ|оформ\S*\s+перевод|переводим|перевед[её]м/i.test(String(decision.reply??'')))
    return {status:'pending',reason:'unbacked_payment_claim'};
  // Owner 2026-11-12 (argnvd): the approved scenario set, word for word, never an invented idea.
  if(decision.action==='cards'&&!event.dryRun&&typeof deliverCards==='function'){
    const sent=await deliverCards({conversationId:event.cid,messageId:event.message_id,recipientId:decision.recipientId});
    if(sent.status!=='verified')return {status:'pending',reason:'delivery_'+sent.status};
    await saveProof({event_id:event.event_id,cid:event.cid,message_id:event.message_id,verified:true,proof:'Original Meta outgoing receipt read back',outgoing_id:sent.outgoingId,executor:'diana_direct_workflow',cards:true});
    const acknowledged=await acknowledge(event);
    return acknowledged?{status:'complete',reason:'scenario_cards_sent',outgoing_id:sent.outgoingId}:{status:'pending',reason:'newer_event_preserved'};
  }
  // 2026-11-12: «спасибо», «ок», ❤️ — nothing to answer. The event is closed, not parked.
  if(decision.action==='none'&&!event.dryRun){const acknowledged=await acknowledge(event);return acknowledged?{status:'complete',reason:'no_reply_needed'}:{status:'pending',reason:'newer_event_preserved'};}
  if(decision.action!=='reply')return {status:'pending',reason:decision.reason,...(event.dryRun?{images_read:Number(decision.receipt?.images_read??0),images_uncertain:Number(decision.receipt?.images_uncertain??0),images_unavailable:Number(decision.receipt?.images_unavailable??0),image_diagnostics:decision.receipt?.image_diagnostics??null}:{}),image_trace:decision.receipt?.image_trace??[]};
  const delivery=await deliver({conversationId:event.cid,messageId:event.message_id,recipientId:decision.recipientId,text:decision.reply});
  if(delivery.status==='preview')return {status:'preview',images_read:Number(decision.receipt?.images_read??0),images_uncertain:Number(decision.receipt?.images_uncertain??0),images_unavailable:Number(decision.receipt?.images_unavailable??0),image_diagnostics:decision.receipt?.image_diagnostics??null};
  if(delivery.status!=='verified')return {status:'pending',reason:'delivery_'+delivery.status};
  const proof={event_id:event.event_id,cid:event.cid,message_id:event.message_id,verified:true,proof:'Original Meta outgoing receipt read back',outgoing_id:delivery.outgoingId,executor:'diana_direct_workflow'};
  await saveProof(proof);
  const acknowledged=await acknowledge(event);
  return acknowledged?{status:'complete',outgoing_id:delivery.outgoingId,image_trace:decision.receipt?.image_trace??[]}:{status:'pending',reason:'newer_event_preserved'};
}

