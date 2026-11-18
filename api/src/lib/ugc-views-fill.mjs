// Owner 2026-11-18 (priority 1): «просмотры роликов должны быть видны в первую очередь».
// Why the icon showed a dash while likes and comments came in:
//   1. Reels counted by the browser (metrics_source instagram_browser / diana_visual) carry only what
//      the Instagram post page shows — likes and comments. The page never shows plays.
//      Plays come only from the Apify reading (videoPlayCount).
//   2. Those reels were never sent to Apify: the cadence treated them as checked, and with no
//      publication date it waited 30 days.
//   3. The nightly sweep was cut off on 17 and 18.11 before it reached the readings, so even the
//      newest reels (12–18.11) were never read.
// This step runs first in the night, newest reel first, and saves each reel the moment it is read.
// A run cut off later loses nothing already saved. No figure is invented: a reading without plays
// leaves the dash and the reel stays in the queue.
import { instagramPostFallback } from './ugc-apify.mjs';

const DAY = 86_400_000;
const ACTIVITY = `COALESCE(julianday(published_at), CASE WHEN typeof(imported_at) IN ('integer','real') THEN imported_at/86400000.0+2440587.5 ELSE julianday(imported_at) END)`;

export async function fillMissingViews(env, { limit = 40, budgetMs = 4 * 60_000, exclude = [], read = instagramPostFallback, now = Date.now } = {}) {
  const started = now();
  const skip = exclude.slice(0, 200), marks = skip.map((_, i) => '?' + (i + 2)).join(',');
  const rows = (await env.DB.prepare(`SELECT id, content_url, published_at FROM ugc_content
      WHERE views IS NULL AND content_url LIKE '%instagram.com/%'
        AND (content_url LIKE '%/reel/%' OR content_url LIKE '%/p/%' OR content_url LIKE '%/tv/%')
        AND COALESCE(link_status,'') NOT IN ('missing','invalid')${skip.length ? ` AND id NOT IN (${marks})` : ''}
      ORDER BY ${ACTIVITY} DESC, id LIMIT ?1`).bind(Math.max(1, Math.min(100, Math.trunc(limit))), ...skip).all()).results ?? [];
  const totals = { ids: rows.map(r => r.id), selected: rows.length, filled: 0, pending: 0, no_views: 0, unread: 0, budget_exhausted: false, first: null };
  const save = async (row, seen) => {
    if (seen.views == null) { totals.no_views++; return; }
    await env.DB.prepare(`UPDATE ugc_content SET views=?2, likes=COALESCE(?3,likes), comments=COALESCE(?4,comments),
        metrics_checked_at=?5, metrics_source='apify', published_at=COALESCE(published_at,?6), updated_at=?7 WHERE id=?1 AND views IS NULL`)
      .bind(row.id, seen.views, seen.likes ?? null, seen.comments ?? null, seen.observedAt ?? new Date().toISOString(), seen.postedAt ?? null, Date.now()).run();
    totals.filled++;
    if (!totals.first) totals.first = row.id;
  };
  const waiting = [];
  // Pass 1: start or reuse a reading for each reel. A reading saved within a day is reused.
  for (const row of rows) {
    if (now() - started >= budgetMs) break;
    let seen;
    try { seen = await read(env, { url: row.content_url, cacheForMs: DAY }); } catch { totals.unread++; continue; }
    if (seen?.status === 'budget_exhausted') { totals.budget_exhausted = true; break; }
    if (seen?.status === 'pending') { waiting.push(row); continue; }
    if (seen?.status === 'ok') await save(row, seen); else totals.unread++;
  }
  // Pass 2: collect the readings that were still running, in the same night.
  for (const row of waiting) {
    if (now() - started >= budgetMs) { totals.pending++; continue; }
    let seen;
    try { seen = await read(env, { url: row.content_url, cacheForMs: DAY }); } catch { totals.unread++; continue; }
    if (seen?.status === 'ok') await save(row, seen);
    else if (seen?.status === 'pending' || seen?.status === 'unknown') totals.pending++;
    else totals.unread++;
  }
  await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES('ugc_views_fill:last',?1,?2)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(JSON.stringify({ ...totals, ids: undefined, at: new Date().toISOString() }), Date.now()).run();
  return totals;
}
