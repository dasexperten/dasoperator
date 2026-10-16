// Pure parsing for the blogger measurement (ugc-diagnose.ts). Instagram public meta lines:
//   profile: «3,492 Followers, 414 Following, 1,392 Posts - …»
//   post:    «24K likes, 108 comments - krainova_nadya on March 9, 2026: "…"»

/** «3,492» → 3492, «24K» → 24000, «1.2M» → 1200000, «12,5 тыс.» → 12500. */
export function parseCount(s) {
  const t = String(s ?? '').trim().replace(/\s/g, '');
  const m = t.match(/^([\d.,]+)([KkMmТт]?)/);
  if (!m) return null;
  const mult = /[Kk]/.test(m[2]) || /[Тт]/.test(m[2]) ? 1000 : /[Mm]/.test(m[2]) ? 1_000_000 : 1;
  let num = m[1];
  if (mult === 1) num = num.replace(/[.,]/g, '');
  else num = num.replace(',', '.');
  const v = Number(num) * mult;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

/** «14 likes, 0 comments - x on October 16, 2026: …» → { likes, comments, at } or null. */
export function parsePostMeta(meta) {
  const s = String(meta ?? '').replace(/&#x27;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const m = s.match(/^([\d.,]+[KkMm]?)\s+likes?,\s+([\d.,]+[KkMm]?)\s+comments?\b/i);
  if (!m) return null;
  const d = s.match(/\bon\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  const month = d ? MONTHS[d[1].toLowerCase()] : undefined;
  return {
    likes: m[1] === '0' ? 0 : (parseCount(m[1]) ?? 0),
    comments: m[2] === '0' ? 0 : (parseCount(m[2]) ?? 0),
    at: d && month !== undefined ? Date.UTC(Number(d[3]), month, Number(d[2])) : null,
  };
}

/** Six newest posts by date (a pinned old post drops out) → mean(likes + comments) / followers × 100. */
export function engagementLast6(followers, posts) {
  const dated = posts.filter((p) => p && p.at != null).sort((a, b) => b.at - a.at).slice(0, 6);
  if (!(followers > 0) || !dated.length) return null;
  return dated.reduce((s, p) => s + p.likes + p.comments, 0) / dated.length / followers * 100;
}
