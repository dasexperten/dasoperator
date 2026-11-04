// Owner 2026-11-04: who is the author of an Instagram post, read from the public post page.
const HANDLE = /^[A-Za-z0-9_.]{1,30}$/;

function decode(s) {
  return String(s ?? '').replace(/&#x27;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Post shortcode from a reel or post link, or null. */
export function instagramPostCode(url) {
  const m = String(url ?? '').match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i);
  return m ? m[1] : null;
}

/** Author handle of a rendered Instagram post page, or null when the page does not say. */
export function parsePostOwner(html) {
  const s = String(html ?? '');
  const meta = s.match(/<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+content="([^"]+)"/)?.[1];
  if (meta) {
    const d = decode(meta);
    const m = d.match(/(?:^|\s-\s)([A-Za-z0-9_.]{1,30})\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/);
    if (m && HANDLE.test(m[1])) return m[1].toLowerCase();
  }
  const owner = s.match(/"owner"\s*:\s*\{[^{}]*?"username"\s*:\s*"([A-Za-z0-9_.]{1,30})"/)?.[1];
  return owner ? owner.toLowerCase() : null;
}

/** Decide the outcome of the three checks. */
export function decideRename(oldHandle, { graphUsername = null, postOwners = [], profileAlive = false } = {}) {
  const old = String(oldHandle ?? '').toLowerCase();
  const g = graphUsername && HANDLE.test(graphUsername) ? graphUsername.toLowerCase() : null;
  if (g && g !== old) return { outcome: 'renamed', handle: g, evidence: 'Instagram по постоянному номеру аккаунта' };
  const other = postOwners.map((o) => String(o).toLowerCase()).find((o) => HANDLE.test(o) && o !== old);
  if (other) return { outcome: 'renamed', handle: other, evidence: 'автор нашего ролика в Instagram' };
  if (g === old || postOwners.some((o) => String(o).toLowerCase() === old) || profileAlive) return { outcome: 'alive', handle: old, evidence: g === old ? 'Instagram по постоянному номеру аккаунта' : profileAlive ? 'профиль открылся' : 'наш ролик открылся' };
  return { outcome: 'gone', handle: old, evidence: 'ни номер аккаунта, ни ролики, ни профиль не отвечают' };
}
