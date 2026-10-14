// /ugc table figures (Marika, Owner 2026-10-14 «приведи эту таблицу в порядок»).
// Owner override 14.10.2026 for this screen: «не 10 542, а прямо одним числом 10542»,
// counts carry no digit groups. Whole numbers for counts, one decimal for ER,
// the percent sign held to its number with a non-breaking space (§4h-2).

const NBSP = ' ';
const COUNT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0, useGrouping: false });
const RATE = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, useGrouping: false });

/** Followers, views, posts: «5964», never «5 964», «5,964» or «1 447,7». */
export function formatCount(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return COUNT.format(Math.round(Number(value))).replace(/\s/g, NBSP);
}

/** Engagement rate: «4,2 %». */
export function formatRate(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${RATE.format(Number(value)).replace(/\s/g, NBSP)}${NBSP}%`;
}

/** Last activity, Yerevan day: «12.10», or «12.10.25» outside the current year. */
export function formatActivity(ms, nowMs = Date.now()) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const parts = (value) => Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', year: '2-digit' })
    .formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const at = parts(Number(ms));
  const now = parts(nowMs);
  return at.year === now.year ? `${at.day}.${at.month}` : `${at.day}.${at.month}.${at.year}`;
}

const PLATFORM_LABEL = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  vk: 'VK',
  youtube: 'YouTube',
  telegram: 'Telegram',
  facebook: 'Facebook',
  shopee: 'Shopee',
  lazada: 'Lazada',
  other: 'Другое',
};

/** Brand spelling of the network, not CSS capitalisation. */
export function platformLabel(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return '—';
  return PLATFORM_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
