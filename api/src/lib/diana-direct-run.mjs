// Orchestrates one signal in memory. Do not return messages or decisions from
// a Workflow step: Cloudflare persists step results. Only status and IDs leave.
export async function runDirect({event,readOriginal,decide,deliver,saveProof,acknowledge}) {
  const source=await readOriginal({conversationId:event.cid,messageId:event.message_id});
  if(source.status!=='ready')return {status:'superseded'};
  const decision=await decide(source);
  if(decision.action!=='reply')return {status:'pending',reason:decision.reason,...(event.dryRun?{images_read:Number(decision.receipt?.images_read??0),images_uncertain:Number(decision.receipt?.images_uncertain??0),images_unavailable:Number(decision.receipt?.images_unavailable??0),image_diagnostics:decision.receipt?.image_diagnostics??null}:{})};
  const delivery=await deliver({conversationId:event.cid,messageId:event.message_id,recipientId:decision.recipientId,text:decision.reply});
  if(delivery.status==='preview')return {status:'preview',images_read:Number(decision.receipt?.images_read??0),images_uncertain:Number(decision.receipt?.images_uncertain??0),images_unavailable:Number(decision.receipt?.images_unavailable??0),image_diagnostics:decision.receipt?.image_diagnostics??null};
  if(delivery.status!=='verified')return {status:'pending',reason:'delivery_'+delivery.status};
  const proof={event_id:event.event_id,cid:event.cid,message_id:event.message_id,verified:true,proof:'Original Meta outgoing receipt read back',outgoing_id:delivery.outgoingId,executor:'diana_direct_workflow'};
  await saveProof(proof);
  const acknowledged=await acknowledge(event);
  return acknowledged?{status:'complete',outgoing_id:delivery.outgoingId}:{status:'pending',reason:'newer_event_preserved'};
}
