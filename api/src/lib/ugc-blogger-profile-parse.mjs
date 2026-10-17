import { parseCount } from './ugc-diagnose-parse.mjs';

const unescapeHtml = value => String(value ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
export function parseInstagramProfile(html) {
  const meta = new Map();
  for (const tag of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), unescapeHtml(m[3])]));
    meta.set(attrs.get('property') ?? attrs.get('name'), attrs.get('content'));
  }
  const description = meta.get('og:description') ?? meta.get('description') ?? '';
  const number = '([\\d.,\\s]+(?:[KkMm]|тыс\\.?|млн\\.?)?)';
  const count = label => {
    const value = description.match(new RegExp(number + '\\s*' + label, 'i'))?.[1]?.trim().replace(/^[.,\s]+/, '');
    return value === '0' ? 0 : value ? parseCount(value.replace(/млн\.?/i, 'M')) : null;
  };
  const candidate = meta.get('og:image');
  return { followers: count('(?:Followers|подписчик)'), posts: count('(?:Posts|публикаци)'), avatar: isInstagramAvatarUrl(candidate) ? candidate : null };
}

export function isInstagramAvatarUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'lookaside.fbsbx.com' || /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname));
  } catch { return false; }
}
