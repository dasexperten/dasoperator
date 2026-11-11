// Owner 2026-11-11: a reel or post the blogger forwards arrives through the Graph
// poll as an empty is_unsupported message. Meta's webhook carries the same message
// with the exact link (ig_reel / ig_post / share). We keep that link per message id
// and put it back into the conversation, so Diana sees the forwarded publication
// itself instead of asking blindly. Nothing is guessed from the blogger's profile.
export const SHARE_PREFIX = 'ig_share:';
const SHARE_TYPES = new Set(['ig_reel', 'ig_post', 'share', 'reel', 'story_mention', 'ig_story']);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). Constant-time compare. */
export async function validSignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  if (want.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

const safeUrl = value => {
  try { const u = new URL(String(value)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};

/** Every forwarded publication in a webhook body, one entry per message attachment. */
export function extractShares(payload) {
  const out = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const event of Array.isArray(entry?.messaging) ? entry.messaging : []) {
      const message = event?.message;
      if (!message?.mid || message.is_echo) continue;
      for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
        const type = String(attachment?.type ?? '');
        const url = safeUrl(attachment?.payload?.url);
        if (!SHARE_TYPES.has(type) || !url) continue;
        out.push({ mid: String(message.mid), type, url, sender: String(event?.sender?.id ?? ''),
          title: typeof attachment.payload.title === 'string' ? attachment.payload.title.slice(0, 500) : null,
          media_id: String(attachment.payload.ig_post_media_id ?? attachment.payload.reel_video_id ?? '') || null,
          at: Number(event?.timestamp) || null });
        break; // one publication per message is enough to identify it
      }
    }
  }
  return out;
}

/** Store shares and fill the archived message text when it is still empty. */
export async function saveShares(db, shares, now = Date.now()) {
  for (const s of shares) {
    await db.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(SHARE_PREFIX + s.mid, JSON.stringify(s), now).run();
    await db.prepare("UPDATE ugc_ig_messages SET text=?2 WHERE id=?1 AND (text IS NULL OR text='')").bind(s.mid, s.url).run();
  }
  return shares.length;
}

/** Put stored share links back into Graph messages that arrived empty. Returns how many were filled. */
export async function applyShares(db, messages) {
  const empty = (messages ?? []).filter(m => m?.id && !(typeof m.message === 'string' && m.message.trim()) && !(m.shares?.data ?? []).some(s => s?.link));
  let filled = 0;
  for (const m of empty) {
    const row = await db.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(SHARE_PREFIX + String(m.id)).first();
    if (!row) continue;
    let share = null; try { share = JSON.parse(row.value); } catch { continue; }
    if (!share?.url) continue;
    m.message = share.url;
    m.shares = { data: [{ link: share.url }] };
    m.forwarded = { type: share.type, title: share.title ?? null };
    m.is_unsupported = false;
    filled++;
  }
  return filled;
}
