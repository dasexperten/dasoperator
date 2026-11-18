// Owner 2026-11-19 00:10 Yerevan: «к утру должны быть просмотры — проверь последние 500 роликов,
// прям 500, по API, и запиши в ERP». A one-off job with its own ceiling ($0.01 a reel, $5 in all);
// it does not eat the shared daily Apify budget of the regular checks.
// The ERP minute tick moves it one step at a time: start one Apify run for 25 reels, collect it,
// write views / likes / comments, start the next. A batch is never started twice, so nothing is paid twice.
import { instagramPostTarget, parseApifyPost } from './ugc-apify.mjs';

export const VIEWS_JOB = { id: 'views-500-2026-11-19', limit: 500, batch: 25 };
const KEY = 'ugc_views_job:' + VIEWS_JOB.id;
const ACTIVITY = `COALESCE(julianday(x.published_at), CASE WHEN typeof(x.imported_at) IN ('integer','real') THEN x.imported_at/86400000.0+2440587.5 ELSE julianday(x.imported_at) END)`;
const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'];

export async function tickViewsJob(env, { fetchImpl = fetch, now = Date.now(), job = VIEWS_JOB, key = KEY } = {}) {
  if (!env.APIFY_TOKEN || !env.DB) return { status: 'disabled' };
  const db = env.DB;
  const row = (await db.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).all()).results?.[0];
  if (!row) {
    const ids = ((await db.prepare(`SELECT x.id FROM ugc_content x JOIN ugc_creators c ON c.id=x.creator_id AND c.archived_at IS NULL
        WHERE x.content_url LIKE '%instagram.com/%' AND (x.content_url LIKE '%/reel/%' OR x.content_url LIKE '%/p/%' OR x.content_url LIKE '%/tv/%')
          AND COALESCE(x.link_status,'') NOT IN ('missing','invalid')
        ORDER BY ${ACTIVITY} DESC, x.id LIMIT ?1`).bind(job.limit).all()).results ?? []).map(r => String(r.id));
    const first = { phase: ids.length ? 'working' : 'done', queue: ids, selected: ids.length, read: 0, with_views: 0, no_views: 0, unread: 0, runs: 0, run: null, lease: 0, started_at: new Date(now).toISOString() };
    await db.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO NOTHING').bind(key, JSON.stringify(first), now).run();
    return { status: 'created', selected: ids.length };
  }
  let state; try { state = JSON.parse(row.value); } catch { return { status: 'broken' }; }
  if (state.phase === 'done' || state.phase === 'stopped') return { status: state.phase };
  if (Number(state.lease) > now) return { status: 'busy' };
  // One tick at a time: the lease is taken on the exact value read above.
  const leased = { ...state, lease: now + 150_000 };
  const taken = await db.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind(key, JSON.stringify(leased), now, row.value).run();
  if (!Number(taken?.meta?.changes)) return { status: 'busy' };
  state = leased;
  const save = () => db.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1').bind(key, JSON.stringify({ ...state, lease: 0 }), Date.now()).run();
  const request = async (path, init = {}) => {
    const response = await fetchImpl(`https://api.apify.com/v2/${path}`, { ...init, headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, 'Content-Type': 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(50_000) });
    if (!response.ok) throw new Error('Apify request failed');
    return response.json();
  };
  if (state.run) {
    const run = state.run; let items = null, observedAt = new Date(now).toISOString(), over = Boolean(run.ambiguous);
    if (run.id) {
      try {
        const { data } = await request(`actor-runs/${run.id}`);
        if (!TERMINAL.includes(data.status)) {
          // A run that hangs past 15 minutes is given up; its reels are counted unread, never re-bought here.
          if (now - Number(run.at) < 15 * 60_000) { await save(); return { status: 'collecting' }; }
        } else if (/^[A-Za-z0-9]+$/.test(data.defaultDatasetId || '')) {
          items = await request(`datasets/${data.defaultDatasetId}/items?format=json&clean=true&limit=200`);
          if (Number.isFinite(Date.parse(data.finishedAt))) observedAt = new Date(data.finishedAt).toISOString();
        }
        over = true;
      } catch { if (now - Number(run.at) < 15 * 60_000) { await save(); return { status: 'collecting' }; } over = true; }
    }
    if (over) {
      for (const reel of run.reels ?? []) {
        const seen = Array.isArray(items) ? parseApifyPost(items, reel.url) : null;
        if (!seen) { state.unread++; continue; }
        state.read++;
        if (seen.views == null) state.no_views++; else state.with_views++;
        if ([seen.views, seen.likes, seen.comments].some(v => v != null)) {
          await db.prepare(`UPDATE ugc_content SET views=COALESCE(?2,views), likes=COALESCE(?3,likes), comments=COALESCE(?4,comments), metrics_checked_at=?5,
              metrics_source='apify', link_status='active', link_checked_at=?5, published_at=COALESCE(published_at,?6), updated_at=?7 WHERE id=?1`)
            .bind(reel.id, seen.views ?? null, seen.likes ?? null, seen.comments ?? null, observedAt, seen.postedAt ?? null, Date.now()).run();
        }
        // The reading is kept where the regular checks look first, so the same reel is not bought again within a day.
        const result = { status: 'ok', source: 'apify', observedAt, runId: run.id, ...seen };
        await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
            WHERE NOT (json_valid(crm_sync_state.value) AND json_extract(crm_sync_state.value,'$.phase') IN ('starting','running'))`)
          .bind('ugc-apify:post:' + seen.shortcode, JSON.stringify({ phase: 'done', at: Date.parse(observedAt), result }), Math.floor(Date.now() / 1000)).run();
      }
      // Two batches in a row with nothing readable mean the reading itself is broken: stop, do not burn the rest.
      state.empty = (run.reels ?? []).length && !(Array.isArray(items) && (run.reels ?? []).some(r => parseApifyPost(items, r.url))) ? Number(state.empty ?? 0) + 1 : 0;
      state.run = null;
      if (state.empty >= 2) { state.phase = 'stopped'; await save(); return { status: 'stopped' }; }
    }
  }
  if (!state.run && state.queue.length) {
    const ids = state.queue.slice(0, job.batch); state.queue = state.queue.slice(job.batch);
    const marks = ids.map((_, i) => '?' + (i + 1)).join(',');
    const rows = (await db.prepare(`SELECT id, content_url FROM ugc_content WHERE id IN (${marks})`).bind(...ids).all()).results ?? [];
    const reels = [], urls = [];
    for (const r of rows) {
      const target = instagramPostTarget(String(r.content_url ?? '').split('?')[0]);
      if (!target) { state.unread++; continue; }
      reels.push({ id: String(r.id), url: target.url });
      if (!urls.includes(target.url)) urls.push(target.url);
    }
    state.unread += ids.length - rows.length;
    if (urls.length) {
      // The batch is written down before the paid call: if the call is cut off, it is not repeated.
      state.run = { ambiguous: true, at: now, reels }; state.runs++;
      await db.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1').bind(key, JSON.stringify(state), Date.now()).run();
      try {
        const response = await request(`acts/apify~instagram-scraper/runs?maxTotalChargeUsd=${(urls.length * 0.01).toFixed(2)}&waitForFinish=20&timeout=600`,
          { method: 'POST', body: JSON.stringify({ directUrls: urls, resultsType: 'posts', resultsLimit: 1, addParentData: false }) });
        if (/^[A-Za-z0-9]+$/.test(response.data?.id || '')) state.run = { id: response.data.id, at: now, reels };
      } catch { /* stays ambiguous: counted unread on the next tick */ }
    }
  }
  if (!state.run && !state.queue.length) { state.phase = 'done'; state.finished_at = new Date().toISOString(); }
  await save();
  return { status: state.phase === 'done' ? 'done' : 'working', left: state.queue.length, read: state.read, with_views: state.with_views };
}
