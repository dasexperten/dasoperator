// =============================================================================
// Mail images guard — no letter leaves with an empty picture (Owner 2026-10-22).
//
// Case: the Magnit letter from Denis Vasilevski (22.10.2026) carried his
// portrait from www.dasexperten.com/assets/agents/, where seats added after the
// July batch were never published. Outlook showed «Рисунок удалён отправителем».
//
// Owner's law, word for word in effect: if a photo does not open, our logo goes
// in its place — nothing else, never an empty frame.
//
//   1. Agent portraits are read from the live board store (org.dasexperten.com).
//      A legacy www.dasexperten.com/assets/agents/ link is rewritten first.
//   2. Every remote <img> is opened before the letter leaves. A picture that does
//      not answer 200 with a mail-safe image type (png, jpeg, gif) is replaced by
//      the brand logo. webp counts as broken: Outlook does not show it.
//   3. data: and cid: images are inside the letter itself and are left alone.
// =============================================================================

export const AGENT_AVATAR_BASE = 'https://org.dasexperten.com/assets/agents';
export const MAIL_LOGO_URL = 'https://org.dasexperten.com/assets/brand/das-experten-logo-mail.png';
// Natural ratio of the logo file (585 × 112), shown at signature size.
const LOGO_W = 125;
const LOGO_H = 24;

const LEGACY_AVATAR = /https?:\/\/(?:www\.)?dasexperten\.com\/assets\/agents\//gi;
const MAIL_SAFE_TYPE = /^image\/(png|jpe?g|gif)\b/i;
const IMG_TAG = /<img\b[^>]*>/gi;

function srcOf(tag) {
  const m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
}

function logoTag() {
  return `<img src="${MAIL_LOGO_URL}" width="${LOGO_W}" height="${LOGO_H}" alt="Das Experten" style="display:block;border:0">`;
}

/** Open one picture the way a mail client would. */
export async function imageOpens(url, fetchImpl = fetch, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    // Body is not needed; release it so the subrequest closes.
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return res.status === 200 && MAIL_SAFE_TYPE.test(type);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns { html, replaced } — html with legacy portrait links moved to the live
 * store and every picture that does not open swapped for the logo.
 */
export async function guardMailImages(html, fetchImpl = fetch) {
  if (!html || !/<img\b/i.test(html)) return { html, replaced: [] };
  let out = html.replace(LEGACY_AVATAR, `${AGENT_AVATAR_BASE}/`);

  const tags = out.match(IMG_TAG) || [];
  const checked = new Map();
  const replaced = [];
  for (const tag of tags) {
    const src = srcOf(tag).trim();
    if (!src || /^(data|cid):/i.test(src)) continue;
    if (src === MAIL_LOGO_URL) continue;
    if (!checked.has(src)) checked.set(src, /^https?:\/\//i.test(src) ? await imageOpens(src, fetchImpl) : false);
    if (!checked.get(src)) {
      out = out.replace(tag, logoTag());
      replaced.push(src);
    }
  }
  return { html: out, replaced };
}
