import type { Env } from '../types';
// Owner 2026-11-06: ERP never drafts creator text. Existing callers only queue metadata for Diana.
export async function dianaCompose(env: Env, handle: string, _brief: string): Promise<string[] | null> {
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const message = await env.DB.prepare(`SELECT id,conversation_id,created_at FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1 ORDER BY created_at DESC LIMIT 1`)
    .bind(normalized).first<{ id: string; conversation_id: string; created_at: string }>();
  if (!message) return null;
  const alarm = { handle: normalized, cid: message.conversation_id, message_id: message.id, at: message.created_at, reason: 'diana_action_pending', rang_at: new Date().toISOString() };
  await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind('diana_round_alarm:' + message.conversation_id, JSON.stringify(alarm), Date.now()).run();
  return null;
}
