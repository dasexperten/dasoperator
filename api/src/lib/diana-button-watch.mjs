// Owner 2026-11-11: details without a button must be visible within the hour, not after
// three days (_bikmatinki, medisamiasi). Once an hour: every chat with an incoming message
// in the last 7 days is read from the ERP archive with Diana's own details rule; a chat
// whose phone, bank and name have no payout from that cycle is listed. No phone is stored.
import { latestRequisites } from './ugc-latest-requisites.mjs';
export const WATCH_KEY = 'diana_button_watch';
const WEEK = 7 * 86_400_000, HOUR = 3_600_000;

export async function findMissingButtons(db, now = Date.now()) {
  const since = new Date(now - WEEK).toISOString(), from = new Date(now - 2 * WEEK).toISOString();
  const rows = (await db.prepare(`SELECT id, conversation_id, direction, from_username, text, created_at FROM ugc_ig_messages
      WHERE created_at >= ?2 AND conversation_id IN (SELECT DISTINCT conversation_id FROM ugc_ig_messages WHERE direction='in' AND created_at >= ?1)
      ORDER BY conversation_id, created_at`).bind(since, from).all()).results ?? [];
  const chats = new Map();
  for (const r of rows) { if (!chats.has(r.conversation_id)) chats.set(r.conversation_id, []); chats.get(r.conversation_id).push(r); }
  const missing = [];
  for (const [cid, list] of chats) {
    const handle = String(list.filter(m => m.direction === 'in' && m.from_username).at(-1)?.from_username ?? '').toLowerCase();
    if (!handle) continue;
    let req = null;
    try { req = latestRequisites(list.map(m => ({ id: String(m.id), direction: m.direction, text: String(m.text ?? ''), created_at: new Date(Date.parse(String(m.created_at).replace(/\+0000$/, 'Z')) || 0).toISOString() }))); } catch { continue; }
    if (!req || !(Number(req.source_at) >= now - WEEK)) continue;
    const paid = await db.prepare(`SELECT 1 AS present FROM ugc_payouts p LEFT JOIN ugc_creator_platforms cp ON cp.creator_id=p.creator_id AND cp.platform='instagram'
        WHERE (lower(p.handle)=?1 OR cp.normalized_handle=?1) AND p.created_at >= ?2 LIMIT 1`).bind(handle, Number(req.source_at) - 3 * 86_400_000).first();
    if (!paid) missing.push({ handle, cid, since: new Date(Number(req.source_at)).toISOString(), first_name: req.first_name ?? null });
  }
  return missing;
}

/** Hourly; returns null when the hour was already done. */
export async function runButtonWatch(db, now = Date.now()) {
  const hour = String(Math.floor(now / HOUR));
  const lease = await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_button_watch_hour',?1,?2)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE crm_sync_state.value<>?1`).bind(hour, now).run();
  if (!lease.meta?.changes) return null;
  const missing = await findMissingButtons(db, now);
  await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(WATCH_KEY, JSON.stringify({ at: now, missing }), now).run();
  return missing.length;
}
