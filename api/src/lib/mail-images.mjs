// =============================================================================
// Mail images guard — no letter leaves with an empty picture (Owner 2026-10-22).
//
// Case: the Magnit letter from Denis Vasilevski (22.10.2026) carried his
// portrait from www.dasexperten.com/assets/agents/, where seats added after the
// July batch were never published. Outlook showed «Рисунок удалён отправителем».
//
// Owner's law (2026-10-22, revised the same evening): if a photo does not open,
// nothing goes in its place — the picture and its signature cell are removed,
// the signature stays as text. Never an empty frame, never a substitute.
//
//   1. Agent portraits are read from the live board store (org.dasexperten.com).
//      A legacy www.dasexperten.com/assets/agents/ link is rewritten first.
//   2. Every remote <img> is opened before the letter leaves. A picture that does
//      not answer 200 with a mail-safe image type (png, jpeg, gif) is removed,
//      together with a table cell it alone filled. webp counts as broken:
//      Outlook does not show it.
//   3. data: and cid: images are inside the letter itself and are left alone.
// =============================================================================

export const AGENT_AVATAR_BASE = 'https://org.dasexperten.com/assets/agents';

const LEGACY_AVATAR = /https?:\/\/(?:www\.)?dasexperten\.com\/assets\/agents\//gi;
const MAIL_SAFE_TYPE = /^image\/(png|jpe?g|gif)\b/i;
const IMG_TAG = /<img\b[^>]*>/gi;

function srcOf(tag) {
  const m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
}

const CUT = '\u0000mail-image-cut\u0000';

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
 * Returns { html, removed } — html with legacy portrait links moved to the live
 * store and every picture that does not open taken out, with its cell.
 */
export async function guardMailImages(html, fetchImpl = fetch) {
  if (!html || !/<img\b/i.test(html)) return { html, removed: [] };
  let out = html.replace(LEGACY_AVATAR, `${AGENT_AVATAR_BASE}/`);

  const tags = out.match(IMG_TAG) || [];
  const checked = new Map();
  const removed = [];
  for (const tag of tags) {
    const src = srcOf(tag).trim();
    if (!src || /^(data|cid):/i.test(src)) continue;
    if (!checked.has(src)) checked.set(src, /^https?:\/\//i.test(src) ? await imageOpens(src, fetchImpl) : false);
    if (!checked.get(src)) {
      out = out.replace(tag, CUT);
      removed.push(src);
    }
  }
  if (removed.length) {
    // A cell that held only the picture goes too, so no blank gap is left.
    out = out.replace(new RegExp(`<td\\b[^>]*>\\s*(?:${CUT}\\s*)+</td>`, 'gi'), '').split(CUT).join('');
  }
  return { html: out, removed };
}
