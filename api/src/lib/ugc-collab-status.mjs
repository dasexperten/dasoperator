// Owner 2026-11-07 (Marika): Collab status of each Instagram post, decided from two Graph lists.
// confirmed — the post's shortcode is among our accepted collaborative media (exact, by link).
// requested — the creator has N open invites to us; Graph gives no link for an invite, so the
//             creator's N newest posts that are not yet confirmed carry the grey mark.

const SHORTCODE = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function postCode(url) {
  const m = String(url ?? '').match(SHORTCODE);
  return m ? m[1] : null;
}

/** Media number behind a shortcode; larger is newer. */
export function codeOrder(code) {
  let n = 0n;
  for (const ch of String(code ?? '').slice(0, 11)) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return 0n;
    n = n * 64n + BigInt(i);
  }
  return n;
}

/**
 * rows: [{ id, handle, content_url, published_at }]
 * confirmedCodes: Set of shortcodes; invites: Map handle(lower) -> open invite count.
 * Returns Map id -> 'confirmed' | 'requested' | null.
 */
export function decideCollab(rows, confirmedCodes, invites) {
  const out = new Map();
  const byHandle = new Map();
  for (const row of rows) {
    const code = postCode(row.content_url);
    if (code && confirmedCodes.has(code)) { out.set(row.id, 'confirmed'); continue; }
    out.set(row.id, null);
    const handle = String(row.handle ?? '').toLowerCase();
    if (!handle || !code) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, []);
    byHandle.get(handle).push({ id: row.id, order: row.published_at ? BigInt(Date.parse(row.published_at) || 0) * 1000000n : 0n, code: codeOrder(code) });
  }
  for (const [handle, list] of byHandle) {
    const open = invites.get(handle) ?? 0;
    if (!open) continue;
    list.sort((a, b) => (b.code > a.code ? 1 : b.code < a.code ? -1 : 0));
    for (const item of list.slice(0, open)) out.set(item.id, 'requested');
  }
  return out;
}
