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
 * @template {{ id: string, content_url?: string | null, link_status?: string | null, published_at?: string | null, imported_at?: string | number | null, product_evidence?: string | null }} T
 * @param {{ content: T[] }[]} profiles
 * @returns {{ item: T, href: string }[]}
 */
export function creatorPublicationLinks(profiles) {
  const seen = new Set();
  const shown = (item) => Boolean(contentHref(item.content_url)) && item.link_status !== 'missing';
  const live = new Set(profiles.flatMap((profile) => profile.content.filter(shown).map((item) => item.id)));
  const links = profiles.flatMap((profile) => profile.content.flatMap((item) => {
    const href = contentHref(item.content_url);
    // Owner 2026-11-19: «if the reel does not exist do not show it anymore». A publication the check
    // found removed (link_status 'missing') leaves the table; the record and its figures stay in ERP.
    if (!href || seen.has(item.id) || item.link_status === 'missing') return [];
    // Owner 2026-11-19: a video she sent in Direct that is frame for frame the publication standing
    // next to it is not shown a second time. If that publication is removed, the sent file is back.
    const twin = publishedAs(item);
    if (twin && twin !== item.id && live.has(twin)) return [];
    seen.add(item.id);
    return [{ item, href }];
  }));
  return links.sort((a, b) => publicationTime(b.item) - publicationTime(a.item)).slice(0, 5);
}

/** Id of the publication a sent Direct file was found identical to, or null. */
function publishedAs(item) {
  if (!item.product_evidence || !String(item.id).startsWith('ugcc_dv_')) return null;
  try {
    const id = JSON.parse(item.product_evidence)?.published_as;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
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
