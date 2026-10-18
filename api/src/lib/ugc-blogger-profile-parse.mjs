import { parseCount } from './ugc-diagnose-parse.mjs';

const unescapeHtml = value => String(value ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
export function parseInstagramProfile(html, expectedHandle) {
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
  if (expectedHandle) {
    const handle = String(expectedHandle).toLowerCase();
    let matched = false;
    try {
      const url = new URL(meta.get('og:url'));
      matched = /^(?:www\.)?instagram\.com$/.test(url.hostname) && url.pathname.replace(/^\/|\/$/g, '').toLowerCase() === handle;
    } catch { /* A generic/login page is not an observed creator profile. */ }
    const titleHandle = (meta.get('og:title') ?? '').match(/\(@([A-Za-z0-9_.]+)\)/)?.[1]?.toLowerCase();
    if (!matched && titleHandle !== handle) return { followers: null, posts: null, avatar: null };
  }
  return { followers: count('(?:Followers|подписчик)'), posts: count('(?:Posts|публикаци)'), avatar: isInstagramAvatarUrl(candidate) ? candidate : null };
}

export function isInstagramAvatarUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    // A trusted CDN also hosts the Instagram logo, post previews and silhouettes.
    // Only the profile-picture path is an avatar source; the observed default
    // silhouette is not a creator's custom photo.
    if (u.pathname.includes('573323465_1219825463302212_7278921664109726296_n.jpg')) return false;
    return u.hostname === 'lookaside.fbsbx.com' || (/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(u.hostname) && /\/t51\.\d+-19\//.test(u.pathname));
  } catch { return false; }
}
