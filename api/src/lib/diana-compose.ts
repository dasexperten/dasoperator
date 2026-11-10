import type { Env } from '../types';
// Owner 2026-11-06: ERP never drafts creator text. Existing callers only queue metadata for Diana.
export async function queueDianaAction(env: Env, handle: string, brief: string, identity?: string, metadata?: { task: string; payout_id?: string; question_id?:string; paid_at?: string; failed_at?: string; status?: string; konsol_status?: string; konsol_payment_id?: string; amount_minor?: number; currency?: string; reminder_cycle?: number }) {
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const message = await env.DB.prepare(`SELECT id,conversation_id,created_at FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1 ORDER BY created_at DESC LIMIT 1`)
    .bind(normalized).first<{ id: string; conversation_id: string; created_at: string }>();
  if (!message) return { ok: false, error: 'Не найден исходный диалог для задачи Диане' };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity ?? normalized + ':' + message.id + ':' + brief));
  const eventId = 'action:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  const done = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_event_done:' + eventId).first();
  if (done) return { ok: true, completed: true, eventId };
  const alarm = { handle: normalized, cid: message.conversation_id, message_id: message.id, event_id: eventId, at: new Date().toISOString(), source_at: message.created_at, reason: 'diana_action_pending', ...(metadata ?? {}), rang_at: new Date().toISOString() };
  const existing=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_action_pending:'+eventId).first();
  const inserted = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=json_patch(crm_sync_state.value,?4),updated_at=excluded.updated_at WHERE json_valid(crm_sync_state.value) AND json_extract(crm_sync_state.value,'$.event_id')=?5 AND ?4<>'{}'`)
    .bind('diana_action_pending:' + eventId, JSON.stringify(alarm), Date.now(),JSON.stringify(metadata??{}),eventId).run();
  let dispatch:{dispatched:boolean;reason?:string}={dispatched:false,reason:'dispatch_unavailable'};
  try{
    const channel=env.DIANA_WAKE.get(env.DIANA_WAKE.idFromName('diana'));
    const response=await channel.fetch('https://wake.internal/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({priority_event_id:eventId})});
    if(response.ok){const out=await response.json() as any;dispatch={dispatched:out.dispatched===true,...(typeof out.reason==='string'?{reason:out.reason}:{})};}
  }catch{} // Durable work remains queued. A wake failure never means the creator was notified.
  try{await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind('diana_action_dispatch:'+eventId,JSON.stringify({event_id:eventId,payout_id:metadata?.payout_id??null,task:metadata?.task??null,attempted_at:new Date().toISOString(),...dispatch}),Date.now()).run();}catch{console.warn('[diana-wake] dispatch receipt unavailable');}
  return { ok: true, queued: true, newlyQueued: !existing&&Number(inserted.meta?.changes ?? (inserted as any).changes ?? 0) > 0, eventId,dispatch };
}

export async function dianaCompose(env: Env, handle: string, brief: string, identity?: string): Promise<string[] | null> {
  await queueDianaAction(env, handle, brief, identity);
  return null;
}
