import type { Env } from '../types';
import { cacheIncomingImages } from './ig-dm-image-cache';
const BRAND_ID = '17841466350261166';

/** Restored bytes reopen only a transport failure; business review stays put. */
export async function resumeRecoveredIgImage(env: Env, conversationId: string) {
  await env.DB.prepare(`DELETE FROM crm_sync_state WHERE key=?1 AND json_valid(value)
    AND json_extract(value,'$.kind')='technical'
    AND json_extract(value,'$.reason') IN ('image_read_failed','current_image_unavailable','current_attachment_metadata_unavailable')`)
    .bind(`ig_reply_escalated:${conversationId}`).run();
}

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
        // Owner 2026-10-20 (_umm_abdu.llah_blog «Вот»): a shared reel or post arrives as shares{link}, not text.
        (typeof message.message === 'string' && message.message ? message.message.slice(0, 4000) : (message.shares?.data?.[0]?.link ? String(message.shares.data[0].link) : (typeof message.message === 'string' ? message.message : null))), attachmentJson,
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
    try { await cacheIncomingImages(env, String(message.id), message.attachments.data); if(repaired)await resumeRecoveredIgImage(env,conversationId); }
    catch { /* metadata is retained; the reader retries a failed download */ }
  }
  return { inserted, repaired, incoming: inserted && !outgoing };
}
