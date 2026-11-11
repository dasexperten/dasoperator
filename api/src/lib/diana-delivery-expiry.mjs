// Owner 2026-11-11: an unconfirmed Diana send never stays unknown forever.
// While Instagram still lets us answer (7 days after the blogger's last message,
// HUMAN_AGENT window) the ERP shows «ответ не дошёл» with the deadline. After that
// the record is closed with the final reason «окно истекло, ответ невозможен».
// A send is never replayed here: closing is bookkeeping, not a second message.
export const WINDOW_MS = 7 * 86_400_000;
const DELIVERY = 'diana_direct_delivery:';
const EVENT = 'diana_direct_event:message:';
const time = v => { const t = Date.parse(String(v ?? '').replace(/\+0000$/, 'Z')); return Number.isFinite(t) ? t : null; };
const parse = v => { try { return JSON.parse(v); } catch { return null; } };

async function conversation(db, cid) {
  const row = await db.prepare(`SELECT
      max(CASE WHEN direction='in' THEN created_at END) last_in,
      max(CASE WHEN direction='out' THEN created_at END) last_out,
      (SELECT from_username FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in' AND from_username IS NOT NULL ORDER BY created_at DESC LIMIT 1) handle
    FROM ugc_ig_messages WHERE conversation_id=?1`).bind(cid).first();
  return { lastIn: time(row?.last_in), lastOut: time(row?.last_out), handle: row?.handle ? String(row.handle).toLowerCase() : null };
}

/** Conversations whose last blogger message got no delivered answer. */
export async function undeliveredChats(db, now = Date.now()) {
  const rows = (await db.prepare(`SELECT key, value FROM crm_sync_state WHERE key LIKE ?1
      AND json_extract(value,'$.status') IN ('unknown','expired')`).bind(DELIVERY + '%').all()).results ?? [];
  const seen = new Map();
  for (const row of rows) {
    const v = parse(row.value), cid = v?.conversation_id;
    if (typeof cid !== 'string' || seen.has(cid)) continue;
    const c = await conversation(db, cid);
    // A later answer that reached the chat settles it, whatever the old record says.
    if (c.lastIn === null || (c.lastOut !== null && c.lastOut >= c.lastIn)) continue;
    const until = c.lastIn + WINDOW_MS;
    seen.set(cid, { key: row.key, cid, handle: c.handle, last_in: new Date(c.lastIn).toISOString(), until: new Date(until).toISOString(),
      status: now >= until ? 'expired' : 'undelivered' });
  }
  return [...seen.values()];
}

/** Close records whose Instagram window has ended. Returns how many chats were closed. */
export async function expireUndelivered(db, now = Date.now()) {
  let closed = 0;
  for (const chat of await undeliveredChats(db, now)) {
    if (chat.status !== 'expired') continue;
    const final = { reason: 'instagram_window_closed', note: 'окно истекло, ответ невозможен', closed_at: now, window_until: chat.until };
    const deliveries = (await db.prepare(`SELECT key, value FROM crm_sync_state WHERE key LIKE ?1 AND json_extract(value,'$.status')='unknown'`)
      .bind(`${DELIVERY}${chat.cid}:%`).all()).results ?? [];
    for (const d of deliveries) await db.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
      .bind(d.key, JSON.stringify({ ...parse(d.value), status: 'expired', ...final }), now, d.value).run();
    const events = (await db.prepare(`SELECT s.key, s.value FROM crm_sync_state s JOIN ugc_ig_messages m ON m.id=substr(s.key, ?2)
        WHERE s.key LIKE ?1 AND m.conversation_id=?3 AND json_extract(s.value,'$.status')='needs_review'
          AND json_extract(s.value,'$.reason') IN ('delivery_unknown','delivery_unconfirmed')`)
      .bind(EVENT + '%', EVENT.length + 1, chat.cid).all()).results ?? [];
    for (const e of events) await db.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4')
      .bind(e.key, JSON.stringify({ ...parse(e.value), status: 'closed', ...final }), now, e.value).run();
    if (deliveries.length || events.length) closed++;
  }
  return closed;
}
