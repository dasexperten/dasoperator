// Creator enrichment runs independently of payment readiness (Owner 2026-10-16).
// Our own headless browser (Cloudflare Browser Rendering, the browser-run path), no login:
//   profile page → followers from its meta line, post codes from the page;
//   each post page → «N likes, M comments - handle on <date>»;
//   ER = mean(likes + comments) of the six newest posts by date / followers × 100.
// A pinned post is old and drops out by the date sort.
import { parseInstagramProfile } from './ugc-blogger-profile-parse.mjs';
import type { Env } from '../types';
import { parsePostMeta, engagementLast6, type PostMeta } from './ugc-diagnose-parse.mjs';

const PER_RUN = 3;
const METHOD = 'public_last6_posts_by_date:mean(likes+comments)/followers*100; observed; cloudflare browser rendering (no login)';

export async function render(env: Env, url: string, wait: 'networkidle0' | 'domcontentloaded', timeout = 60_000): Promise<string | null> {
  const token = (env as unknown as { CF_BROWSER_TOKEN?: string }).CF_BROWSER_TOKEN ?? '';
  const account = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID ?? '081ddb85cb399ad62a70210328d744fc';
  if (!token) return null;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/content`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, gotoOptions: { waitUntil: wait, timeout: Math.min(45_000, timeout - 1000) } }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`browser HTTP ${res.status}`);
  const j = await res.json() as { result?: string };
  return typeof j.result === 'string' ? j.result : null;
}

/** One blogger: followers + ER of the six newest posts, or nulls when Instagram shows nothing. */
export async function measureInstagram(env: Env, handle: string): Promise<{ followers: number | null; er: number | null; posts?: number | null; avatar?: string | null; sample?: number }> {
  const deadline = Date.now() + 45_000;
  const profile = await render(env, `https://www.instagram.com/${encodeURIComponent(handle)}/`, 'networkidle0', 25_000);
  if (!profile) return { followers: null, er: null };
  const parsed = parseInstagramProfile(profile, handle);
  const followers = parsed.followers;
  const codes: string[] = [];
  for (const m of profile.matchAll(/\/(?:p|reel)\/([A-Za-z0-9_-]{8,})/g)) if (!codes.includes(m[1]!)) codes.push(m[1]!);
  const posts: PostMeta[] = [];
  for (const code of codes.slice(0, 9)) {
    if (Date.now() >= deadline) break;
    const html = await render(env, `https://www.instagram.com/p/${code}/`, 'domcontentloaded', Math.min(10_000, Math.max(1000, deadline - Date.now()))).catch(() => null);
    const meta = html?.match(/<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+content="([^"]+)"/)?.[1];
    const p = meta ? parsePostMeta(meta) : null;
    if (p) posts.push(p);
  }
  return { followers, er: followers ? engagementLast6(followers, posts) : null, posts: parsed.posts, avatar: parsed.avatar, sample: Math.min(6, posts.filter(p => p.at != null).length) };
}

/**
 * Every Instagram creator in the ERP is measured, not only paid ones (Owner 2026-10-17:
 * «ERP worker должен проверить всех блогеров, которые у нас есть в ERP»).
 * Order: a live Direct conversation (last 7 days) → a payout → never measured → oldest reading.
 * Fresh for 30 days; a profile that showed nothing is asked again after 7 days
 * (6 hours while the blogger is in a live conversation).
 */
export async function diagnosePayoutCreators(env: Env): Promise<{ measured: number; error?: string }> {
  if (!(env as unknown as { CF_BROWSER_TOKEN?: string }).CF_BROWSER_TOKEN) return { measured: 0, error: 'CF_BROWSER_TOKEN not set' };
  const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT h FROM (
       SELECT cp.normalized_handle h, cp.metrics_as_of m,
              EXISTS (SELECT 1 FROM ugc_ig_messages im WHERE im.direction='in' AND lower(im.from_username)=cp.normalized_handle AND im.created_at > ?4) live,
              EXISTS (SELECT 1 FROM ugc_payouts p WHERE p.creator_id=cp.creator_id) paid,
              (cp.followers IS NULL OR cp.followers <= 0 OR cp.engagement_rate IS NULL) gap
         FROM ugc_creator_platforms cp JOIN ugc_creators c ON c.id=cp.creator_id WHERE cp.platform='instagram' AND c.archived_at IS NULL)
      WHERE m IS NULL OR m < ?1 OR (gap AND m < CASE WHEN live THEN ?3 ELSE ?2 END)
      ORDER BY live DESC, paid DESC, (m IS NULL) DESC, m ASC
      LIMIT ${PER_RUN}`
  ).bind(iso(30 * 86_400_000), iso(7 * 86_400_000), iso(6 * 3_600_000), iso(7 * 86_400_000)).all<{ h: string }>()).results ?? [];
  let measured = 0;
  let error: string | undefined;
  for (const { h } of rows) {
    let m: { followers: number | null; er: number | null } = { followers: null, er: null };
    try { m = await measureInstagram(env, h); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    // Stamp the attempt either way, so a blogger Instagram hides is asked again only after six hours.
    await env.DB.prepare(
      `UPDATE ugc_creator_platforms SET followers=COALESCE(?2, followers), engagement_rate=COALESCE(?3, engagement_rate),
         engagement_rate_method=CASE WHEN ?3 IS NULL THEN engagement_rate_method ELSE ?4 END, metrics_as_of=?5, updated_at=?6
       WHERE platform='instagram' AND normalized_handle=?1`
    ).bind(h, m.followers, m.er, METHOD, new Date().toISOString(), Date.now()).run();
    if (m.followers || m.er != null) measured++;
  }
  return error ? { measured, error } : { measured };
}

// Owner 2026-10-16: «есть ссылки, но нет views, likes и комментариев». Counts were read once
// and never refreshed, and a removed post kept the label «active». Each run now reads a few
// Instagram publications through the same browser: likes and comments from the page meta,
// views only when the page itself shows them; a removed post is marked missing.
const CONTENT_PER_RUN = 4;

export async function refreshContentMetrics(env: Env): Promise<{ read: number; removed: number; error?: string }> {
  if (!(env as unknown as { CF_BROWSER_TOKEN?: string }).CF_BROWSER_TOKEN) return { read: 0, removed: 0, error: 'CF_BROWSER_TOKEN not set' };
  const rows = (await env.DB.prepare(
    `SELECT id, content_url FROM ugc_content
      WHERE content_url LIKE '%instagram.com/%' AND COALESCE(link_status, '') NOT IN ('missing', 'invalid')
        AND (metrics_checked_at IS NULL OR metrics_checked_at < ?1)
      ORDER BY metrics_checked_at IS NOT NULL, metrics_checked_at, RANDOM() LIMIT ${CONTENT_PER_RUN}`
  ).bind(new Date(Date.now() - 7 * 86_400_000).toISOString()).all<{ id: string; content_url: string }>()).results ?? [];
  let read = 0, removed = 0;
  let error: string | undefined;
  for (const row of rows) {
    const code = row.content_url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/)?.[1];
    const now = new Date().toISOString();
    if (!code) continue;
    let html: string | null = null;
    try { html = await render(env, `https://www.instagram.com/p/${code}/`, 'networkidle0'); } catch (e) { error = e instanceof Error ? e.message : String(e); continue; }
    if (!html) continue;
    if (/<title[^>]*>[^<]*(?:isn.t available|недоступ)/i.test(html)) {
      await env.DB.prepare(
        `UPDATE ugc_content SET link_status='missing', link_checked_at=?2, link_check_note='Post removed or hidden (browser)', metrics_checked_at=?2, metrics_source='instagram_browser', updated_at=?3 WHERE id=?1`
      ).bind(row.id, now, Date.now()).run();
      removed++;
      continue;
    }
    const meta = html.match(/<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+content="([^"]+)"/)?.[1];
    const p = meta ? parsePostMeta(meta) : null;
    const num = (re: RegExp) => { const v = html!.match(re)?.[1]; return v == null ? null : Number(v); };
    const views = num(/"(?:ig_play_count|play_count|video_play_count|video_view_count|view_count)":(\d+)/);
    const likes = p?.likes ?? num(/"like_count":(\d+)/);
    const comments = p?.comments ?? num(/"comment_count":(\d+)/);
    if (likes == null && comments == null && views == null) continue; // nothing shown: try again next week
    await env.DB.prepare(
      `UPDATE ugc_content SET views=COALESCE(?2, views), likes=COALESCE(?3, likes), comments=COALESCE(?4, comments),
         metrics_checked_at=?5, metrics_source='instagram_browser', link_status='active', link_checked_at=?5, updated_at=?6 WHERE id=?1`
    ).bind(row.id, views, likes, comments, now, Date.now()).run();
    read++;
  }
  return error ? { read, removed, error } : { read, removed };
}
