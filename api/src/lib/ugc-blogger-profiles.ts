import type { Env } from '../types';
import { instagramProfileFallback } from './ugc-apify.mjs';
import { refreshCadence, dueCadenceSql } from './ugc-refresh-cadence.mjs';
import { measureInstagram, render } from './ugc-diagnose';
import { parseInstagramProfile, isInstagramAvatarUrl } from './ugc-blogger-profile-parse.mjs';

async function graph(path: string, token: string): Promise<any | null> {
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as any;
    return response.ok && !data?.error ? data : null;
  } catch { return null; }
}

async function saveAvatar(env: Env, id: string, url?: string | null): Promise<string | null> {
  if (!isInstagramAvatarUrl(url)) return null;
  let current = url!;
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!isInstagramAvatarUrl(current)) return null;
    response = await fetch(current, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DasExpertenProfile/1.0)' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { current = new URL(response.headers.get('location')!, current).href; continue; }
    break;
  }
  if (!response) return null;
  if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(response.headers.get('content-type')?.split(';')[0] ?? '')) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 1024 * 1024) { await reader.cancel(); return null; }
    chunks.push(item.value);
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest === 'b421b00fd1791a1d1ab70dd1e9667f40ca79a8c8673989864f1be092295cd7da') return null;
  const key = `ugc/blogger-avatars/${id}`;
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: response.headers.get('content-type')! } });
  return key;
}

// Independent of payouts and Direct. Every 3h during the Owner's working window: bloggers never checked yet (Owner 2026-10-18: «где followers»);
// Activity-age cadence is evaluated at existing timer slots; a manual target bypasses cadence, not budget.
// Missing values never erase previously observed values; attempts and successes differ.
export async function refreshBloggerProfiles(env: Env, profileId?: string, limit = 500, options: { avatarOnly?: boolean; avatarUrl?: string } = {}) {
  const lease = crypto.randomUUID();
  const lock = 'lock:erp-blogger-id';
  const claimed = await env.DB.prepare(`INSERT INTO erp_job_claims (worker,slot,lease_until) VALUES (?,?,?)
    ON CONFLICT(worker) DO UPDATE SET slot=excluded.slot,lease_until=excluded.lease_until WHERE erp_job_claims.lease_until<=?
    RETURNING worker`).bind(lock, lease, Date.now() + 15 * 60_000, Date.now()).first();
  if (!claimed) return { attempted: 0, updated: 0, busy: true };
  try {
    const rows = (await env.DB.prepare(`WITH collaboration_activity AS MATERIALIZED (
      SELECT creator_id,MAX(MAX(CASE WHEN julianday(last_contact_at)<=julianday('now') THEN julianday(last_contact_at) ELSE 0 END,CASE WHEN julianday(invited_at)<=julianday('now') THEN julianday(invited_at) ELSE 0 END,CASE WHEN julianday(accepted_at)<=julianday('now') THEN julianday(accepted_at) ELSE 0 END,CASE WHEN julianday(sample_sent_at)<=julianday('now') THEN julianday(sample_sent_at) ELSE 0 END,CASE WHEN julianday(published_at)<=julianday('now') THEN julianday(published_at) ELSE 0 END)) activity_jd FROM ugc_collaborations GROUP BY creator_id
    ), conversation_handles AS MATERIALIZED (
      SELECT lower(from_username) handle,conversation_id FROM ugc_ig_messages
      WHERE direction='in' AND from_username IS NOT NULL GROUP BY lower(from_username),conversation_id
    ), message_activity AS MATERIALIZED (
      SELECT h.handle,MAX(julianday(m.created_at)) activity_jd FROM conversation_handles h
      JOIN ugc_ig_messages m ON m.conversation_id=h.conversation_id
      WHERE julianday(m.created_at)<=julianday('now') GROUP BY h.handle
    ), candidates AS (
      SELECT cp.id,cp.normalized_handle,cp.profile_attempted_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',NULLIF(MAX(COALESCE(ca.activity_jd,0),COALESCE(ma.activity_jd,0)),0)) activity_at,
        (SELECT from_id FROM ugc_ig_messages m WHERE m.direction='in' AND lower(m.from_username)=cp.normalized_handle AND m.from_id IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) igsid
      FROM ugc_creator_platforms cp
      LEFT JOIN collaboration_activity ca ON ca.creator_id=cp.creator_id
      LEFT JOIN message_activity ma ON ma.handle=cp.normalized_handle
      WHERE cp.platform='instagram' AND (?1 IS NULL OR cp.id=?1)
        AND EXISTS (SELECT 1 FROM ugc_creators c WHERE c.id=cp.creator_id AND (c.archived_at IS NULL OR ?1 IS NOT NULL))
    ) SELECT *,COUNT(*) OVER() due_count FROM candidates WHERE ?1 IS NOT NULL OR ${dueCadenceSql('activity_at','profile_attempted_at')}
      ORDER BY CASE WHEN julianday(activity_at)>=julianday('now','-10 days') THEN 0 ELSE 1 END,
        (profile_attempted_at IS NULL) DESC,profile_attempted_at ASC,id ASC LIMIT ?2`)
      .bind(profileId ?? null, Math.min(500, Math.max(1, limit)))
      .all<{ id: string; normalized_handle: string; igsid: string | null; activity_at: string | null; profile_attempted_at: string | null; due_count: number }>()).results ?? [];
    const messagingToken = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
    const pageToken = messagingToken ? (await graph('1697038263872226?fields=access_token', messagingToken))?.access_token : null;
    let updated = 0, attempted = 0, apifyPending = 0;
    const avatars: { profile_id: string; saved: boolean; handle: string; source: string | null }[] = [];
    const deadline = Date.now() + 10 * 60_000;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      attempted++;
      const cadence = refreshCadence({activityAt:row.activity_at,checkedAt:row.profile_attempted_at,manual:Boolean(profileId)});
      const now = new Date().toISOString();
      let error: string | null = null;
      let m: Awaited<ReturnType<typeof measureInstagram>> = { followers: null, er: null };
      let avatar: string | null = null;
      let metricMethod = 'public_last6_posts_by_date:mean(likes+comments)/followers*100';
      let metricsObservedAt = now, erObservedAt = now;
      try {
        if (!/^[A-Za-z0-9_.]{1,30}$/.test(row.normalized_handle)) throw new Error('invalid handle');
        const official = pageToken && row.igsid ? await graph(`${encodeURIComponent(row.igsid)}?fields=username,profile_pic,follower_count`, pageToken) : null;
        const matched = String(official?.username ?? '').toLowerCase() === row.normalized_handle.toLowerCase();
        if (options.avatarOnly) {
          let source = isInstagramAvatarUrl(options.avatarUrl) ? 'browser_observed' : matched && isInstagramAvatarUrl(official.profile_pic) ? 'instagram_graph_username' : null;
          // Avatar backfills do not re-read posts or advance dates on retained metrics.
          let url = isInstagramAvatarUrl(options.avatarUrl) ? options.avatarUrl : matched && isInstagramAvatarUrl(official.profile_pic) ? official.profile_pic : null;
          if (!url) {
            const html = await render(env, `https://www.instagram.com/${encodeURIComponent(row.normalized_handle)}/`, 'domcontentloaded', 15_000).catch(() => null);
            url = html ? parseInstagramProfile(html, row.normalized_handle).avatar : null;
            if (url) source = 'instagram_profile_identity';
          }
          if (!url) {
            const fallback = await instagramProfileFallback(env, { handle: row.normalized_handle, cacheForMs: cadence.cacheForMs });
            if (fallback.status === 'pending' || fallback.status === 'budget_exhausted') apifyPending++;
            if (fallback.status === 'ok' && isInstagramAvatarUrl(fallback.avatar)) { url = fallback.avatar; source = 'apify_profile_identity'; }
          }
          const key = await saveAvatar(env, row.id, url).catch(() => null);
          if (key) {
            await env.DB.prepare("UPDATE ugc_creator_platforms SET avatar_key=?,updated_at=?,availability_status='available',availability_checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),availability_note='Instagram supplied the current profile photo' WHERE id=?")
              .bind(key, Date.now(), row.id).run();
            updated++;
          }
          avatars.push({ profile_id: row.id, handle: row.normalized_handle, saved: Boolean(key), source: key ? source : null });
          continue;
        }
        m = await measureInstagram(env, row.normalized_handle).catch(() => ({ followers: null, er: null }));
        if (matched) {
          if (Number.isSafeInteger(official.follower_count) && official.follower_count >= 0) {
            if (m.followers !== official.follower_count) m.er = null;
            m.followers = official.follower_count;
          }
          if (isInstagramAvatarUrl(official.profile_pic)) m.avatar = official.profile_pic;
        }
        if (m.followers == null || m.posts == null || !isInstagramAvatarUrl(m.avatar) || m.er == null) {
          const fallback = await instagramProfileFallback(env, { handle: row.normalized_handle, cacheForMs: cadence.cacheForMs });
          // No attempt/success stamp while a paid operation needs resumption.
          if (fallback.status === 'pending' || fallback.status === 'budget_exhausted') {
            apifyPending++;
            // Keep independently observed primary values without hiding unfinished fallback work.
            const primaryAvatar = await saveAvatar(env, row.id, m.avatar).catch(() => null);
            if (m.followers != null || m.posts != null || m.er != null || primaryAvatar) {
              await env.DB.prepare(`UPDATE ugc_creator_platforms SET
                followers=COALESCE(?2,followers),posts_count=COALESCE(?3,posts_count),avatar_key=COALESCE(?4,avatar_key),
                engagement_rate=COALESCE(?5,engagement_rate),er_sample_posts=CASE WHEN ?5 IS NULL THEN er_sample_posts ELSE ?6 END,
                er_checked_at=CASE WHEN ?5 IS NULL THEN er_checked_at ELSE ?7 END,
                engagement_rate_method=CASE WHEN ?5 IS NULL THEN engagement_rate_method ELSE ?8 END,
                metrics_as_of=CASE WHEN ?2 IS NOT NULL OR ?3 IS NOT NULL THEN ?7 ELSE metrics_as_of END,
                updated_at=?9 WHERE id=?1`)
                .bind(row.id,m.followers,m.posts ?? null,primaryAvatar,m.er,m.sample ?? null,now,metricMethod,Date.now()).run();
            }
            continue;
          }
          if (fallback.status === 'ok') {
            if (m.followers == null && fallback.followers != null) metricsObservedAt = fallback.observedAt ?? now;
            m.followers ??= fallback.followers ?? null;
            m.posts ??= fallback.posts;
            if (!isInstagramAvatarUrl(m.avatar) && isInstagramAvatarUrl(fallback.avatar)) m.avatar = fallback.avatar;
            if (m.er == null && fallback.er != null && fallback.followers === m.followers) {
              m.er = fallback.er; m.sample = fallback.sample ?? undefined; erObservedAt = fallback.observedAt ?? now;
              metricMethod = 'apify_public_last6_posts_by_date:mean(likes+comments)/followers*100';
            }
          }
        }
        avatar = await saveAvatar(env, row.id, m.avatar).catch(() => null);
        if (m.followers == null && m.posts == null && !avatar) error = 'Instagram не открыл данные профиля';
      } catch {
        if (options.avatarOnly) { avatars.push({ profile_id: row.id, handle: row.normalized_handle, saved: false, source: null }); continue; }
        error = 'Не удалось загрузить публичный профиль Instagram';
      }
      const success = m.followers != null || m.posts != null || avatar != null;
      await env.DB.prepare(`UPDATE ugc_creator_platforms SET
        followers=COALESCE(?2,followers),posts_count=COALESCE(?3,posts_count),avatar_key=COALESCE(?4,avatar_key),
        engagement_rate=COALESCE(?5,engagement_rate),er_sample_posts=CASE WHEN ?5 IS NULL THEN er_sample_posts ELSE ?6 END,
        er_checked_at=CASE WHEN ?5 IS NULL THEN er_checked_at ELSE ?12 END,
        engagement_rate_method=CASE WHEN ?5 IS NULL THEN engagement_rate_method ELSE ?11 END,
        profile_attempted_at=?7,profile_checked_at=CASE WHEN ?8 THEN ?7 ELSE profile_checked_at END,
        metrics_as_of=CASE WHEN ?2 IS NOT NULL OR ?3 IS NOT NULL THEN ?13 ELSE metrics_as_of END,
        availability_status=CASE WHEN ?8 THEN 'available' ELSE availability_status END,
        availability_checked_at=CASE WHEN ?8 THEN ?7 ELSE availability_checked_at END,
        availability_note=CASE WHEN ?8 THEN 'Instagram supplied current profile data' ELSE availability_note END,
        profile_error=?9,updated_at=?10 WHERE id=?1`)
        .bind(row.id,m.followers,m.posts ?? null,avatar,m.er,m.sample ?? null,now,success ? 1 : 0,error,Date.now(),metricMethod,erObservedAt,metricsObservedAt).run();
      if (success) updated++;
    }
    return { due: rows[0]?.due_count ?? 0, selected: rows.length, deferred: Math.max(0,(rows[0]?.due_count ?? rows.length)-attempted)+apifyPending, time_budget_exhausted: attempted < rows.length, attempted, updated, apify_pending: apifyPending, busy: false, ...(options.avatarOnly ? { avatars } : {}) };
  } finally {
    await env.DB.prepare('DELETE FROM erp_job_claims WHERE worker=? AND slot=?').bind(lock,lease).run();
  }
}
