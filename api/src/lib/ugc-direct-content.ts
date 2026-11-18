import type { Env } from '../types';
import { publicationLink, publicationLinks, contentReviewKey } from './ugc-publication-links.mjs';
// @ts-expect-error plain JS module
import { watchVideo } from './diana-direct-video-watch.mjs';

// Owner 2026-11-18 (o__kseniaa): «ролик прислала в Direct, Диана поблагодарила — в ERP колонка Контент
// пустая». Diana Direct reads the chat in memory and stores nothing, and the old nightly capture read a
// message archive that stopped on 10.11, so since then nothing a blogger sent in Direct reached her card.
// This is the one door for it. Whatever she sends in the chat lands in Контент of her own card:
//   • a link to her reel or post, typed or shared — a waiting link, confirmed by the content check;
//   • a reel that tags us or a Collab found for her blank message — the same;
//   • a video file — watched by the model; when our product is in it, the file is kept and shown.
// Only a blogger who already has a card is touched; nobody is invented. Conversation text is not stored.
const PAGE = '1697038263872226', BRAND = '17841466350261166';
const OURS = [PAGE, BRAND];
const GRAPH = 'https://graph.facebook.com/v21.0/';
export const DIRECT_VIDEO_BASE = 'https://dasoperator-api.dasexperten.workers.dev/ugc-video/';
const MAX_VIDEO = 60_000_000;

async function sha(prefix: string, input: string, n = 32) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return prefix + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}
const videoOf = (m: any) => (Array.isArray(m?.attachments?.data) ? m.attachments.data : []).find((a: any) => a?.video_data || String(a?.mime_type ?? '').startsWith('video/'));
const videoUrl = (m: any) => { const v = videoOf(m); return v ? String(v.video_data?.url || v.video_data?.video_url || v.file_url || '') : ''; };

async function profileOf(env: Env, handle: string) {
  const name = String(handle ?? '').toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_.]{1,40}$/.test(name)) return null;
  return env.DB.prepare(`SELECT p.id,p.creator_id,p.normalized_handle h FROM ugc_creator_platforms p JOIN ugc_creators c ON c.id=p.creator_id
    WHERE p.platform='instagram' AND p.normalized_handle=?1 AND c.archived_at IS NULL LIMIT 1`).bind(name).first<{ id: string; creator_id: string; h: string }>();
}

/** A publication link of hers becomes a waiting row. Returns true when a row was added. */
async function addLink(env: Env, profile: { id: string; creator_id: string; h: string }, raw: string, evidence: Record<string, unknown>, publishedAt?: string | null): Promise<boolean> {
  const link = publicationLink(raw);
  if (!link) return false;
  const marker = contentReviewKey(profile.creator_id, link.key);
  const known = await env.DB.prepare(`SELECT 1 x FROM ugc_content WHERE creator_id=?1 AND content_url LIKE ?2 UNION ALL SELECT 1 x FROM crm_sync_state WHERE key=?3 LIMIT 1`)
    .bind(profile.creator_id, '%' + link.code + '%', marker).first();
  if (known) return false;
  const target = link.platform === 'instagram' ? profile.id
    : (await env.DB.prepare('SELECT id FROM ugc_creator_platforms WHERE creator_id=?1 AND platform=?2 ORDER BY id LIMIT 1').bind(profile.creator_id, link.platform).first<{ id: string }>())?.id ?? profile.id;
  const id = await sha('ugcc_dm_', profile.creator_id + ':' + link.key);
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO ugc_content (id,creator_id,creator_platform_id,content_url,content_type,published_at,imported_at,updated_at,product_status,product_evidence)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?7,'queued',?8) ON CONFLICT(id) DO NOTHING`)
    .bind(id, profile.creator_id, target, link.url, link.kind, publishedAt ?? null, now, JSON.stringify({ sender: profile.h, publication_platform: link.platform, author_verified: false, our_product: null, ...evidence })).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** A video file with our product is kept in the ERP and shown as her content. */
async function addVideoFile(env: Env, profile: { id: string; creator_id: string; h: string }, message: any, seen: any): Promise<boolean> {
  const url = videoUrl(message);
  if (!url || seen?.our_product !== 'yes') return false;
  const id = await sha('ugcc_dv_', profile.creator_id + ':' + String(message.id));
  if (await env.DB.prepare('SELECT 1 x FROM ugc_content WHERE id=?1').bind(id).first()) return false;
  const host = new URL(url).hostname;
  if (!(host === 'lookaside.fbsbx.com' || host.endsWith('.fbcdn.net') || host.endsWith('.cdninstagram.com'))) return false;
  const file = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'video/*,*/*;q=0.8' } });
  if (!file.ok || !file.body || Number(file.headers.get('content-length') ?? 0) > MAX_VIDEO) return false;
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_VIDEO) return false;
  const key = 'ugc/direct-video/' + id + '.mp4';
  await env.DOCS.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
  const at = Number.isFinite(Date.parse(message.created_time)) ? new Date(Date.parse(message.created_time)).toISOString() : new Date().toISOString();
  const now = Date.now();
  const r = await env.DB.prepare(`INSERT INTO ugc_content (id,creator_id,creator_platform_id,content_url,content_type,published_at,download_url,imported_at,updated_at,
      product_status,product_source,product_evidence,product_checked_at,link_status,link_checked_at)
    VALUES (?1,?2,?3,?4,'video',?5,?4,?6,?6,'identified','vision',?7,?8,'active',?8) ON CONFLICT(id) DO NOTHING`)
    .bind(id, profile.creator_id, profile.id, DIRECT_VIDEO_BASE + id, at, now,
      JSON.stringify({ discovery: 'instagram_direct_file', sender: profile.h, source_message_at: at, author_verified: true, our_product: true, product_seen: seen.product_seen ?? null, summary: seen.summary ?? null, kind: seen.kind ?? null, face_visible: seen.face_visible ?? null, in_use: seen.in_use ?? null, reviewer: 'erp-content-check' }),
      new Date(now).toISOString()).run();
  return Number(r.meta?.changes ?? 0) > 0;
}

type Recorded = { links: number; videos: number };

/** Everything in one conversation that is her content. `seenVideo` carries what Diana already watched. */
export async function recordDirectContent(env: Env, input: { handle: string; messages: any[]; publication?: any; seenVideo?: { message_id: string; facts: any } | null; watch?: boolean }): Promise<Recorded> {
  const out: Recorded = { links: 0, videos: 0 };
  const profile = await profileOf(env, input.handle);
  if (!profile) return out;
  const incoming = (input.messages ?? []).filter(m => m?.id && !OURS.includes(String(m.from?.id ?? '')));
  for (const m of incoming) {
    const at = Number.isFinite(Date.parse(m.created_time)) ? new Date(Date.parse(m.created_time)).toISOString() : null;
    const texts = [String(m.message ?? ''), ...((m.shares?.data ?? []) as any[]).map(s => String(s?.link ?? ''))];
    for (const link of publicationLinks(texts.join(' '))) {
      if (await addLink(env, profile, link.url, { discovery: 'instagram_direct', source_message_at: at }).catch(() => false)) out.links++;
    }
  }
  const p = input.publication;
  if (p?.permalink && await addLink(env, profile, String(p.permalink), { discovery: p.kind === 'invite' ? 'instagram_collab_invite' : 'instagram_tag', author_verified: true }, p.published_at ?? null).catch(() => false)) out.links++;
  const key = (env as unknown as { GEMINI_API_KEY?: string }).GEMINI_API_KEY;
  let watched = 0;
  for (const m of incoming.filter(videoOf).slice(-4)) {
    try {
      const id = await sha('ugcc_dv_', profile.creator_id + ':' + String(m.id));
      if (await env.DB.prepare('SELECT 1 x FROM ugc_content WHERE id=?1').bind(id).first()) continue;
      const doneKey = 'direct_video_seen:' + String(m.id);
      let facts = input.seenVideo?.message_id === String(m.id) ? input.seenVideo.facts : null;
      if (!facts) {
        if (input.watch === false || !key || watched >= 2) continue;
        if (await env.DB.prepare('SELECT 1 x FROM crm_sync_state WHERE key=?1').bind(doneKey).first()) continue;
        watched++;
        facts = await watchVideo({ apiKey: key, url: videoUrl(m) });
      }
      if (!facts) continue;
      const added = await addVideoFile(env, profile, m, facts);
      if (added) out.videos++;
      // The verdict is remembered, never the video: a file without our product is not watched twice.
      await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .bind(doneKey, JSON.stringify({ handle: profile.h, our_product: facts.our_product ?? 'unknown', kept: added }), Date.now()).run();
    } catch { /* one video never stops the rest; it is tried again on the next round */ }
  }
  return out;
}

/** The twice-daily round opens the chat itself, so a reel sent while nobody looked is still caught. */
export async function scanDirectContent(env: Env, handle: string, cid: string): Promise<Recorded> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token || !cid) return { links: 0, videos: 0 };
  const get = async (path: string, key: string) => {
    const r = await fetch(GRAPH + path, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || body?.error) throw Error('direct_content_meta_' + r.status);
    return body;
  };
  const page = await get(`${PAGE}?fields=access_token`, token);
  if (!page.access_token) return { links: 0, videos: 0 };
  const list = await get(`${encodeURIComponent(cid)}/messages?fields=id,created_time,from,message,attachments{mime_type,video_data,file_url},shares{link}&limit=50`, page.access_token);
  const messages = (list.data ?? []).slice().reverse();
  const hers = messages.filter((m: any) => !OURS.includes(String(m.from?.id ?? ''))).at(-1);
  if (!hers || String(hers.from?.username ?? '').toLowerCase() !== String(handle).toLowerCase()) return { links: 0, videos: 0 };
  const { applyShares } = await import('./ig-share-webhook.mjs');
  await applyShares(env.DB, messages).catch(() => 0);
  return recordDirectContent(env, { handle, messages });
}

/** Collab publications on her profile where we are the accepted co-author (Owner 2026-11-18). */
export async function recordCollabMedia(env: Env): Promise<{ recorded: number }> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) return { recorded: 0 };
  let recorded = 0, url: string | null = `https://graph.facebook.com/v22.0/${BRAND}/collaborative_media?fields=permalink,username,timestamp&limit=100`;
  for (let n = 0; url && n < 5; n++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.error) break;
    for (const item of body.data ?? []) {
      const owner = String(item?.username ?? '').toLowerCase();
      if (!owner || !item?.permalink || owner === 'dasexperten') continue;
      const profile = await profileOf(env, owner);
      if (!profile) continue;
      if (await addLink(env, profile, String(item.permalink), { discovery: 'instagram_collab', author_verified: true }, item.timestamp ?? null).catch(() => false)) {
        recorded++;
        const link = publicationLink(String(item.permalink));
        if (link) await env.DB.prepare("UPDATE ugc_content SET collab_status='confirmed',collab_checked_at=?2 WHERE creator_id=?1 AND content_url=?3").bind(profile.creator_id, new Date().toISOString(), link.url).run();
      }
    }
    url = body.paging?.next ?? null;
  }
  return { recorded };
}
