// Before a payout turns brown the blogger is measured (Owner 2026-10-16: «хотя бы
// должно быть количество фолловеров. Средний engagement rate… по последним шести
// постам. Такой анализ делаешь ты, диагностируешь, и после этого всё прописываешь»;
// «APIфай не используй… Jet Browser… Router Run, Agent Reach»).
// Our own headless browser (Cloudflare Browser Rendering, the browser-run path), no login:
//   profile page → followers from its meta line, post codes from the page;
//   each post page → «N likes, M comments - handle on <date>»;
//   ER = mean(likes + comments) of the six newest posts by date / followers × 100.
// A pinned post is old and drops out by the date sort.
import type { Env } from '../types';
import { parseCount, parsePostMeta, engagementLast6, type PostMeta } from './ugc-diagnose-parse.mjs';

const PER_RUN = 2;
const METHOD = 'public_last6_posts_by_date:mean(likes+comments)/followers*100; observed; cloudflare browser rendering (no login)';

async function render(env: Env, url: string, wait: 'networkidle0' | 'domcontentloaded'): Promise<string | null> {
  const token = (env as unknown as { CF_BROWSER_TOKEN?: string }).CF_BROWSER_TOKEN ?? '';
  const account = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID ?? '081ddb85cb399ad62a70210328d744fc';
  if (!token) return null;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/content`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, gotoOptions: { waitUntil: wait, timeout: 45_000 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`browser HTTP ${res.status}`);
  const j = await res.json() as { result?: string };
  return typeof j.result === 'string' ? j.result : null;
}

/** One blogger: followers + ER of the six newest posts, or nulls when Instagram shows nothing. */
export async function measureInstagram(env: Env, handle: string): Promise<{ followers: number | null; er: number | null }> {
  const profile = await render(env, `https://www.instagram.com/${encodeURIComponent(handle)}/`, 'networkidle0');
  if (!profile) return { followers: null, er: null };
  const followers = parseCount(profile.match(/content="([\d.,\sKkMmТтыс]+)\s*(?:Followers|подписчик)/)?.[1] ?? '');
  const codes: string[] = [];
  for (const m of profile.matchAll(/\/(?:p|reel)\/([A-Za-z0-9_-]{8,})/g)) if (!codes.includes(m[1]!)) codes.push(m[1]!);
  const posts: PostMeta[] = [];
  for (const code of codes.slice(0, 9)) {
    const html = await render(env, `https://www.instagram.com/p/${code}/`, 'domcontentloaded').catch(() => null);
    const meta = html?.match(/<meta[^>]+(?:property|name)="(?:og:)?description"[^>]+content="([^"]+)"/)?.[1];
    const p = meta ? parsePostMeta(meta) : null;
    if (p) posts.push(p);
  }
  return { followers, er: followers ? engagementLast6(followers, posts) : null };
}

/** Waiting payouts whose Instagram blogger has no followers or ER yet: measure up to two per run. */
export async function diagnosePayoutCreators(env: Env): Promise<{ measured: number; error?: string }> {
  if (!(env as unknown as { CF_BROWSER_TOKEN?: string }).CF_BROWSER_TOKEN) return { measured: 0, error: 'CF_BROWSER_TOKEN not set' };
  const rows = (await env.DB.prepare(
    `SELECT DISTINCT cp.normalized_handle h FROM ugc_payouts p
       JOIN ugc_creator_platforms cp ON cp.creator_id = p.creator_id AND cp.platform = 'instagram'
      WHERE p.status IN ('awaiting_approval','approved')
        AND (cp.followers IS NULL OR cp.followers <= 0 OR cp.engagement_rate IS NULL)
        AND (cp.metrics_as_of IS NULL OR cp.metrics_as_of < ?1)
      LIMIT ${PER_RUN}`
  ).bind(new Date(Date.now() - 6 * 3_600_000).toISOString()).all<{ h: string }>()).results ?? [];
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
    if (m.followers && m.er != null) measured++;
  }
  return error ? { measured, error } : { measured };
}
