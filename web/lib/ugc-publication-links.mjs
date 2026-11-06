/** @param {string | null | undefined} value */
export function contentHref(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * @template {{ id: string, content_url?: string | null, published_at?: string | null, imported_at?: string | number | null }} T
 * @param {{ content: T[] }[]} profiles
 * @returns {{ item: T, href: string }[]}
 */
export function creatorPublicationLinks(profiles) {
  const seen = new Set();
  const links = profiles.flatMap((profile) => profile.content.flatMap((item) => {
    const href = contentHref(item.content_url);
    if (!href || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ item, href }];
  }));
  return links.sort((a, b) => publicationTime(b.item) - publicationTime(a.item)).slice(0, 5);
}

function timestamp(value) {
  if (value == null || value === '') return 0;
  const number = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(number)) return number < 1e12 ? number * 1000 : number;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : 0;
}

function publicationTime(item) {
  return timestamp(item.published_at) || timestamp(item.imported_at);
}
