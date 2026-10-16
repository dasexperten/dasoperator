export type ArticlePlacement = {
  article_title: string;
  service: string;
  language: string;
  url: string;
  placement_date: string;
};

const SERVICES: Record<string, string> = {
  'medium.com': 'Medium', 'justpaste.it': 'JustPaste', 'reddit.com': 'Reddit',
  'pinterest.com': 'Pinterest', 'telegra.ph': 'Telegraph', 'linkedin.com': 'LinkedIn',
  'facebook.com': 'Facebook', 'quora.com': 'Quora', 'x.com': 'X',
  'tumblr.com': 'Tumblr', 'blogspot.com': 'Blogger', 'instagram.com': 'Instagram',
  'threads.com': 'Threads', 'youtube.com': 'YouTube', 'substack.com': 'Substack',
  'flipboard.com': 'Flipboard', 'wakelet.com': 'Wakelet', 'teletype.in': 'Teletype',
  'livejournal.com': 'LiveJournal', 'amwaly.com': 'Amwaly', 'diigo.com': 'Diigo',
  'calameo.com': 'Calaméo', 'fliphtml5.com': 'FlipHTML5',
};

/** Only publication fields leave the server; account notes and access data stay private. */
export function articlePlacements(value: unknown): ArticlePlacement[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { placements?: unknown }).placements)) {
    throw new Error('Invalid article placement ledger');
  }
  const rows: ArticlePlacement[] = [];
  const seen = new Set<string>();
  for (const item of (value as { placements: unknown[] }).placements) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (!['published', 'verified_published', 'historical_published'].includes(String(p.status))) continue;
    if (/private|pending|draft|under.review/i.test(String(p.visibility ?? ''))) continue;
    const title = String(p.article_title ?? '').trim();
    const domain = String(p.website_domain ?? '').toLowerCase();
    const service = SERVICES[domain] ?? String(p.service ?? '').trim();
    const lang = String(p.language ?? '').toUpperCase().replace(/^VI$/, 'VN');
    if (!title || !service || !/^[A-Z]{2}$/.test(lang)) continue;
    let url: URL;
    try { url = new URL(String(p.permalink)); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))) continue;
    if (seen.has(url.href)) continue;
    const dateValue = String(p.published_at ?? p.publication_date ?? '');
    const date = new Date(dateValue);
    if (!Number.isFinite(date.getTime())) continue;
    const placementDate = /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
      ? dateValue
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yerevan', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    seen.add(url.href);
    rows.push({ article_title: title, service, language: lang, url: url.href, placement_date: placementDate });
  }
  return rows.sort((a, b) => b.placement_date.localeCompare(a.placement_date) || a.service.localeCompare(b.service));
}
