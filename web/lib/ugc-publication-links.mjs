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
 * @template {{ id: string, content_url?: string | null }} T
 * @param {{ content: T[] }[]} profiles
 * @returns {{ item: T, href: string }[]}
 */
export function creatorPublicationLinks(profiles) {
  const seen = new Set();
  return profiles.flatMap((profile) => profile.content.flatMap((item) => {
    const href = contentHref(item.content_url);
    if (!href || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ item, href }];
  }));
}
