import type { Env } from '../types';
// Owner 2026-11-06: ERP never drafts creator text. Existing callers only queue metadata for Diana.
export async function queueDianaAction(env: Env, handle: string, brief: string, identity?: string, metadata?: { task: string; payout_id: string; paid_at: string }) {
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const message = await env.DB.prepare(`SELECT id,conversation_id,created_at FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1 ORDER BY created_at DESC LIMIT 1`)
    .bind(normalized).first<{ id: string; conversation_id: string; created_at: string }>();
  if (!message) return { ok: false, error: 'Не найден исходный диалог для задачи Диане' };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity ?? normalized + ':' + message.id + ':' + brief));
  const eventId = 'action:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  const done = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_event_done:' + eventId).first();
  if (done) return { ok: true, completed: true, eventId };
  const alarm = { handle: normalized, cid: message.conversation_id, message_id: message.id, event_id: eventId, at: new Date().toISOString(), source_at: message.created_at, reason: 'diana_action_pending', ...(metadata ? { task: metadata.task, payout_id: metadata.payout_id, paid_at: metadata.paid_at } : {}), rang_at: new Date().toISOString() };
  const inserted = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind('diana_action_pending:' + eventId, JSON.stringify(alarm), Date.now()).run();
  return { ok: true, queued: true, newlyQueued: Number(inserted.meta?.changes ?? 0) > 0, eventId };
}

export async function dianaCompose(env: Env, handle: string, brief: string, identity?: string): Promise<string[] | null> {
  await queueDianaAction(env, handle, brief, identity);
  return null;
}
