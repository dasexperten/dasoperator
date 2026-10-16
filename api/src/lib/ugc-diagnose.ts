// Before a payout turns brown the blogger is measured (Owner 2026-10-16: «хотя бы
// должно быть количество фолловеров. Средний engagement rate… по последним шести
// постам. Такой анализ делаешь ты, диагностируешь, и после этого всё прописываешь»).
// Instagram public profile through the apify-bridge Worker: followers and the last
// six non-pinned posts → ER = mean(likes + comments) / followers × 100.
import type { Env } from '../types';

const BRIDGE = 'https://apify-bridge.dasexperten.workers.dev/run';
const PER_RUN = 5;
const METHOD = 'public_last6_nonpinned_posts:mean(likes+comments)/followers*100; observed; apify-bridge instagram-profile-scraper';

type Post = { isPinned?: boolean; likesCount?: number; commentsCount?: number };
type Profile = { username?: string; followersCount?: number; latestPosts?: Post[] };

export function engagementLast6(followers: number, posts: Post[]): number | null {
  const six = posts.filter((p) => !p.isPinned).slice(0, 6);
  if (!(followers > 0) || !six.length) return null;
  return six.reduce((s, p) => s + Math.max(0, p.likesCount ?? 0) + Math.max(0, p.commentsCount ?? 0), 0) / six.length / followers * 100;
}

/** Waiting payouts whose Instagram blogger has no followers or ER yet: measure up to five. */
export async function diagnosePayoutCreators(env: Env): Promise<{ measured: number; error?: string }> {
  const auth = (env as unknown as { APIFY_BRIDGE_AUTH?: string }).APIFY_BRIDGE_AUTH ?? '';
  if (!auth) return { measured: 0, error: 'APIFY_BRIDGE_AUTH not set' };
  const rows = (await env.DB.prepare(
    `SELECT DISTINCT cp.normalized_handle h FROM ugc_payouts p
       JOIN ugc_creator_platforms cp ON cp.creator_id = p.creator_id AND cp.platform = 'instagram'
      WHERE p.status IN ('awaiting_approval','approved')
        AND (cp.followers IS NULL OR cp.followers <= 0 OR cp.engagement_rate IS NULL)
        AND (cp.metrics_as_of IS NULL OR cp.metrics_as_of < ?1)
      LIMIT ${PER_RUN}`
  ).bind(new Date(Date.now() - 6 * 3_600_000).toISOString()).all<{ h: string }>()).results ?? [];
  if (!rows.length) return { measured: 0 };
  const handles = rows.map((r) => r.h);
  let body: any;
  try {
    const res = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Auth': auth },
      body: JSON.stringify({ actor: 'apify/instagram-profile-scraper', input: { usernames: handles, resultsLimit: 12 } }),
      signal: AbortSignal.timeout(110_000),
    });
    body = await res.json();
    if (!res.ok) return { measured: 0, error: `bridge HTTP ${res.status}` };
  } catch (e) {
    return { measured: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const items: Profile[] = Array.isArray(body?.items) ? body.items : [];
  const now = new Date().toISOString();
  let measured = 0;
  for (const h of handles) {
    const it = items.find((x) => String(x.username ?? '').toLowerCase() === h);
    // Not found or private: stamp the attempt so the lane does not ask again for six hours.
    const followers = Number(it?.followersCount ?? 0) || null;
    const er = followers ? engagementLast6(followers, it?.latestPosts ?? []) : null;
    await env.DB.prepare(
      `UPDATE ugc_creator_platforms SET followers=COALESCE(?2, followers), engagement_rate=COALESCE(?3, engagement_rate),
         engagement_rate_method=CASE WHEN ?3 IS NULL THEN engagement_rate_method ELSE ?4 END, metrics_as_of=?5, updated_at=?6
       WHERE platform='instagram' AND normalized_handle=?1`
    ).bind(h, followers, er, METHOD, now, Date.now()).run();
    if (followers && er != null) measured++;
  }
  return { measured };
}
