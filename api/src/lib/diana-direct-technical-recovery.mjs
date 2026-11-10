// Fail-closed admission of an ordinary Direct failure into bounded recovery.
// This is not a send/payment retry: recovery uses its own workflow identity,
// reopens the latest Meta original, and must always carry skipPayout.
export async function canRecoverInitialTechnicalFailure(env, event, prior, now) {
 if (!event || event.task || event.dryRun || !event.cid || !event.message_id ||
     event.event_id !== 'message:' + event.message_id ||
     prior?.status !== 'failed' || prior.reason !== 'recovery_technical_retryable' ||
     prior.event_id !== event.event_id || !Number.isFinite(Date.parse(event.at)) || !Number.isFinite(Number(prior.at)) ||
     now - Number(prior.at) < 180000) return false;
 const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(event.event_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 // Only the original workflow, not an unidentifiable resumed/legacy attempt.
 if (prior.workflow_id !== 'direct-v1-' + hash) return false;
 try {
  const status = await (await env.DIANA_CLOUD.get(prior.workflow_id)).status();
  if (!['complete','errored','terminated'].includes(status.status)) return false;
  for (const key of ['diana_event_done:','diana_payout_signal:','diana_payout_reconciliation:']) {
   if (await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key+event.event_id).first()) return false;
  }
  // Any outbox for this original, including pending/unknown sends or action
  // variants, requires reconciliation rather than another autonomous reply.
  const deliveryPrefix = 'ig_reply_delivery:'+event.cid+':'+new Date(event.at).toISOString();
  const delivery = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE substr(key,1,length(?1))=?1 LIMIT 1').bind(deliveryPrefix).first();
  if (delivery) return false;
  // Decisions are persisted before payout intake and before any delivery.
  // Absence is only accepted from a successful R2 HEAD; errors fail closed.
  if (await env.DOCS.head('diana/cloud-direct/v1/'+hash+'/decision.json')) return false;
  if (await env.DOCS.head('diana/cloud-direct/v1/'+hash+'/payment-uncertain-decision.json')) return false;
  return true;
 } catch { return false; }
}
