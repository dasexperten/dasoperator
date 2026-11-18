import type { Env } from '../types';
import { instagramPostFallback } from './ugc-apify.mjs';
import { reviewContent } from './ugc-content-review';

// Owner 2026-11-18: «395 роликов висят: автор и наш товар не подтверждены». Until today nothing
// automatic could confirm a reel: the old machine round that did it was retired on 11.11 and the
// cloud round only recorded «published». This is that missing check. For every waiting Instagram
// link it reads the post once (the shared Apify budget, $0.01 a reading), and confirms it when
//   1. the post belongs to this blogger's own account, and
//   2. it is ours: we are its co-author, or she tags or names Das Experten / TERMO in the caption,
//      or a model that watched the video saw our product in it.
// The same reading brings views, likes, comments and the posting date. A reel that is not hers or
// shows no product of ours stays waiting, with the reason written down; nothing is deleted.
const OURS = /das\s*experten|dasexperten|дас\s*экспертен|termo\s*39|термо\s*39|\btermo\b|(?:^|[^а-яё])термо(?![а-яё])/i;
const BRAND_ACCOUNTS = ['dasexperten', 'dasexperten_ru', 'das_experten', 'dasexperten.ru'];
const DAY = 86_400_000;

type Row = { id: string; creator_id: string; content_url: string; collab_status: string | null; published_at: string | null; h: string | null };
export type ConfirmTotals = { selected: number; confirmed: number; not_ours: number; not_hers: number; waiting: number; unread: number; budget_exhausted: boolean; pending_ids: string[]; ids: string[] };

export function oursByText(caption: unknown, tagged: unknown): boolean {
  const names = Array.isArray(tagged) ? tagged.map(String) : [];
  return OURS.test(String(caption ?? '')) || names.some(n => BRAND_ACCOUNTS.includes(n.toLowerCase()));
}

// The waiting reels due for a check, newest first, Collab ones before the rest. A cheap read on its
// own, so a caller can note what it is about to check before the slow reading starts.
export async function pendingContentIds(env: Env, options: { limit?: number; exclude?: string[] } = {}): Promise<string[]> {
  const limit = Math.max(1, Math.min(30, Math.trunc(options.limit ?? 10))), exclude = (options.exclude ?? []).slice(-400);
  const marks = exclude.map((_, i) => '?' + (i + 2)).join(',');
  const rows = (await env.DB.prepare(`SELECT x.id FROM ugc_content x JOIN ugc_creators c ON c.id=x.creator_id AND c.archived_at IS NULL
    WHERE COALESCE(x.product_status,'')<>'identified' AND x.content_url LIKE '%instagram.com/%'
      AND COALESCE(x.link_status,'') NOT IN ('missing','invalid')
      AND (x.product_checked_at IS NULL OR julianday('now')-julianday(x.product_checked_at)>=7)${exclude.length ? ` AND x.id NOT IN (${marks})` : ''}
    ORDER BY (COALESCE(x.collab_status,'')='confirmed') DESC, x.imported_at DESC, x.id LIMIT ?1`)
    .bind(limit, ...exclude).all<{ id: string }>()).results ?? [];
  return rows.map(r => String(r.id));
}

export async function confirmPendingContent(env: Env, options: { limit?: number; budgetMs?: number; exclude?: string[]; ids?: string[]; watch?: (url: string) => Promise<any> } = {}): Promise<ConfirmTotals> {
  const limit = Math.max(1, Math.min(30, Math.trunc(options.limit ?? 10)));
  const started = Date.now(), budgetMs = options.budgetMs ?? 4 * 60_000;
  const ids = (options.ids ?? []).slice(0, 60), exclude = (options.exclude ?? []).slice(0, 400);
  const marks = (n: number, from: number) => Array.from({ length: n }, (_, i) => '?' + (i + from)).join(',');
  const where = ids.length ? `x.id IN (${marks(ids.length, 2)})` : `(x.product_checked_at IS NULL OR julianday('now')-julianday(x.product_checked_at)>=7)${exclude.length ? ` AND x.id NOT IN (${marks(exclude.length, 2)})` : ''}`;
  const rows = (await env.DB.prepare(`SELECT x.id,x.creator_id,x.content_url,x.collab_status,x.published_at,
      (SELECT p.normalized_handle FROM ugc_creator_platforms p WHERE p.creator_id=x.creator_id AND p.platform='instagram' ORDER BY p.id LIMIT 1) h
    FROM ugc_content x JOIN ugc_creators c ON c.id=x.creator_id AND c.archived_at IS NULL
    WHERE COALESCE(x.product_status,'')<>'identified' AND x.content_url LIKE '%instagram.com/%'
      AND COALESCE(x.link_status,'') NOT IN ('missing','invalid') AND ${where}
    ORDER BY (COALESCE(x.collab_status,'')='confirmed') DESC, x.imported_at DESC, x.id LIMIT ?1`)
    .bind(limit, ...(ids.length ? ids : exclude)).all<Row>()).results ?? [];
  const totals: ConfirmTotals = { selected: rows.length, confirmed: 0, not_ours: 0, not_hers: 0, waiting: 0, unread: 0, budget_exhausted: false, pending_ids: [], ids: [] };
  const note = async (id: string, status: 'queued' | 'unknown', evidence: Record<string, unknown>) => {
    const at = new Date().toISOString();
    await env.DB.prepare('UPDATE ugc_content SET product_status=?2,product_evidence=?3,product_checked_at=?4,updated_at=?5 WHERE id=?1 AND COALESCE(product_status,\'\')<>\'identified\'')
      .bind(id, status, JSON.stringify({ ...evidence, reviewer: 'erp-content-check', at }), at, Date.now()).run();
  };
  const confirm = async (row: Row, source: 'metadata_text' | 'vision', evidence: string, postedAt?: string | null) => {
    await reviewContent(env, row.id, { verdict: 'confirmed', author_verified: true, our_product: true, evidence: evidence.slice(0, 1900),
      ...(postedAt && !row.published_at && Date.parse(postedAt) <= Date.now() ? { published_at: postedAt } : {}) });
    await env.DB.prepare('UPDATE ugc_content SET product_source=?2 WHERE id=?1').bind(row.id, source).run();
    totals.confirmed++;
  };
  for (const row of rows) {
    if (Date.now() - started >= budgetMs) break;
    totals.ids.push(row.id);
    try {
      const handle = String(row.h ?? '').toLowerCase();
      let seen: any = await instagramPostFallback(env, { url: row.content_url, cacheForMs: DAY });
      // A reading saved before 18.11 has no caption or video; it is read once more.
      if (seen?.status === 'ok' && seen.v !== 2 && row.collab_status !== 'confirmed') seen = await instagramPostFallback(env, { url: row.content_url, cacheForMs: 0 });
      if (seen?.status === 'budget_exhausted') { totals.budget_exhausted = true; totals.waiting++; if (row.collab_status !== 'confirmed') continue; }
      else if (seen?.status === 'pending') { totals.waiting++; totals.pending_ids.push(row.id); if (row.collab_status !== 'confirmed') continue; }
      const read = seen?.status === 'ok';
      if (read && [seen.views, seen.likes, seen.comments].some((v: unknown) => v !== null && v !== undefined)) {
        await env.DB.prepare('UPDATE ugc_content SET views=COALESCE(?2,views),likes=COALESCE(?3,likes),comments=COALESCE(?4,comments),metrics_checked_at=?5,metrics_source=\'apify\',link_status=\'active\',link_checked_at=?5,updated_at=?6 WHERE id=?1')
          .bind(row.id, seen.views ?? null, seen.likes ?? null, seen.comments ?? null, seen.observedAt ?? new Date().toISOString(), Date.now()).run();
      }
      // We are the co-author of her publication: Instagram itself ties it to her and to us.
      if (row.collab_status === 'confirmed' && (!read || !handle || seen.ownerUsername === handle)) {
        await confirm(row, 'metadata_text', `Instagram lists @dasexperten as co-author of ${row.content_url}; publication of @${handle || 'creator'}.`, read ? seen.postedAt : null);
        continue;
      }
      if (!read) { totals.unread++; continue; }
      if (!handle || seen.ownerUsername !== handle) {
        totals.not_hers++; await note(row.id, 'unknown', { author_verified: false, our_product: null, owner: seen.ownerUsername ?? null, expected: handle || null }); continue;
      }
      if (oursByText(seen.caption, seen.tagged)) {
        await confirm(row, 'metadata_text', `Post of @${handle} read by Apify at ${seen.observedAt}; she names or tags Das Experten: ${String(seen.caption ?? '').slice(0, 300)}`, seen.postedAt);
        continue;
      }
      // The video is watched only where a caller brings the watcher (Diana's round); a timer worker never calls a model.
      let watched: any = null;
      if (seen.videoUrl && options.watch) { try { watched = await options.watch(seen.videoUrl); } catch { watched = null; } }
      if (watched?.our_product === 'yes') {
        await confirm(row, 'vision', `Post of @${handle} read by Apify at ${seen.observedAt}; the video was watched and shows our product (${watched.product_seen ?? 'Das Experten'}): ${watched.summary}`, seen.postedAt);
        continue;
      }
      // No verdict (the video could not be watched here): the reel stays in the queue for the next check.
      if (seen.videoUrl && !watched) { totals.unread++; continue; }
      totals.not_ours++;
      await note(row.id, 'unknown', { author_verified: true, our_product: watched ? watched.our_product : null, watched: Boolean(watched), summary: watched?.summary ?? null });
    } catch {
      totals.unread++; // one reel never stops the rest; it stays waiting and is tried again later
    }
  }
  return totals;
}
