import type { Env } from '../types';
import { cacheIncomingImages } from './ig-dm-image-cache';
const BRAND_ID = '17841466350261166';

/** A message ID may arrive before its attachment metadata. Re-reading it must
 * enrich the existing row, not permanently preserve the first empty version. */
export async function archiveIgMessage(env: Env, conversationId: string, message: any, seenAt: string, since: number) {
  const attachmentJson = message.attachments?.data?.length ? JSON.stringify(message.attachments.data) : null;
  const outgoing = String(message.from?.id ?? '') === BRAND_ID;
  const fresh = Date.parse(message.created_time) > since;
  let inserted = false, repaired = false;
  if (fresh) {
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO ugc_ig_messages (id, conversation_id, direction, from_id, from_username, text, attachments_json, created_at, seen_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(String(message.id), conversationId, outgoing ? 'out' : 'in', message.from?.id ?? null, message.from?.username ?? null,
        typeof message.message === 'string' ? message.message.slice(0, 4000) : null, attachmentJson,
        new Date(Date.parse(message.created_time)).toISOString(), seenAt).run();
    inserted = (result.meta?.changes ?? 0) === 1;
  }
  if (!inserted && attachmentJson) {
    const result = await env.DB.prepare(`UPDATE ugc_ig_messages SET attachments_json=?2, seen_at=?3
      WHERE id=?1 AND (attachments_json IS NULL OR attachments_json='' OR attachments_json='[]' OR NOT json_valid(attachments_json))`)
      .bind(String(message.id), attachmentJson, seenAt).run();
    repaired = (result.meta?.changes ?? 0) === 1;
  }
  if (!outgoing && attachmentJson && (inserted || repaired)) {
    try { await cacheIncomingImages(env, String(message.id), message.attachments.data); }
    catch { /* metadata is retained; the reader retries a failed download */ }
  }
  return { inserted, repaired, incoming: inserted && !outgoing };
}
