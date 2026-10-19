// Instagram Direct watcher for Diana (Owner 2026-10-15). Reads @dasexperten's
// Direct through the Page with META_IG_MESSAGING_TOKEN (card SECRETS/instagram.md,
// both vaults; never logged) and stores new messages in ugc_ig_messages.
// Sends only one thing: Diana's «перевела» when a payout turns green (sendIgDirect).
// Cadence is not decided here — the adaptive runner calls it (3 / 15 / 30 min).
import type { Env } from '../types';
import { cacheIncomingImages } from './ig-dm-image-cache';
import { archiveIgMessage, resumeRecoveredIgImage } from './ig-dm-archive';
import { bloggerName, cityOf } from './ugc-person-name.mjs';

const G = 'https://graph.facebook.com/v21.0';
const PAGE_ID = '1697038263872226';
const IG_ID = '17841466350261166';
const STATE_KEY = 'ig_dm:last_seen';
const MAX_CONVERSATIONS = 25;

type Answer = { ok: boolean; body: any; error?: string };

async function graph(path: string, token: string): Promise<Answer> {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${G}${path}${sep}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || body?.error) return { ok: false, body, error: String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const NAME_BATCH = 10;

/**
 * Creator's own name after the @handle on /ugc (Owner 2026-10-15): read from the
 * Instagram profile of whoever wrote to @dasexperten (GET /{igsid}?fields=name).
 * Only fills an empty name; never the payout recipient (that can be a third person).
 * A profile that answers without a name is marked '' so it is not asked again.
 */
export async function fillCreatorNames(env: Env, pageToken: string): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT c.id creator_id, c.normalized_handle handle, MIN(m.from_id) from_id
       FROM ugc_ig_messages m
       JOIN ugc_creator_platforms p ON p.platform = 'instagram' AND p.normalized_handle = LOWER(m.from_username)
       JOIN ugc_creators c ON c.id = p.creator_id
      WHERE m.direction = 'in' AND m.from_id IS NOT NULL AND c.display_name IS NULL
      GROUP BY c.id LIMIT ${NAME_BATCH}`
  ).all<{ creator_id: string; handle: string; from_id: string }>()).results ?? [];
  let filled = 0;
  for (const r of rows) {
    const who = await graph(`/${encodeURIComponent(r.from_id)}?fields=name`, pageToken);
    if (!who.ok) continue;
    const raw = typeof who.body?.name === 'string' ? who.body.name.trim().slice(0, 180) : '';
    // Only the person and the city (Owner 2026-10-16): «Life blog| рецепты» is not a name.
    const name = bloggerName(raw, r.handle).slice(0, 180);
    const city = cityOf(raw) || cityOf(r.handle) || null;
    await env.DB.prepare(`UPDATE ugc_creators SET display_name=?2, city=COALESCE(city, ?4), updated_at=?3 WHERE id=?1 AND display_name IS NULL`)
      .bind(r.creator_id, name, Date.now(), city).run();
    if (name) filled++;
  }
  return filled;
}

/**
 * City from the blogger's own answer (Owner 2026-10-16: «спроси город у тех, у кого
 * его нет»). Only creators without a city; the newest message naming a city wins.
 */
export async function fillCitiesFromReplies(env: Env): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT c.id creator_id, m.text FROM ugc_creators c
       JOIN ugc_ig_messages m ON m.direction = 'in' AND LOWER(m.from_username) = c.normalized_handle
      WHERE c.city IS NULL AND m.text IS NOT NULL AND m.text <> '' AND m.created_at >= '2026-10-16'
      ORDER BY m.created_at DESC LIMIT 200`
  ).all<{ creator_id: string; text: string }>()).results ?? [];
  const done = new Set<string>();
  for (const r of rows) {
    if (done.has(r.creator_id)) continue;
    // A short answer («Казань», «из Казани, Татарстан») — not a city inside a long story.
    if (r.text.length > 80) continue;
    const city = cityOf(r.text);
    if (!city) continue;
    await env.DB.prepare(`UPDATE ugc_creators SET city=?2, updated_at=?3 WHERE id=?1 AND city IS NULL`).bind(r.creator_id, city, Date.now()).run();
    done.add(r.creator_id);
  }
  return done.size;
}

/**
 * One Direct message from @dasexperten to a blogger who has written to us
 * (Owner 2026-10-16: green payout → Diana writes at once). The recipient is the
 * Instagram id from that blogger's own incoming messages; no id → nothing sent.
 */
/**
 * Live check before an automatic reply: is the newest message in this Instagram
 * conversation still the blogger's? Read from Instagram itself, not the ERP copy.
 */
export async function lastWordIsBlogger(env: Env, conversationId: string, expectedAt?: string): Promise<boolean | null> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return null;
  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return null;
  const r = await graph(`/${conversationId}?fields=messages.limit(1){from,created_time}`, String(page.body.access_token));
  if (!r.ok) return null;
  const top = r.body?.messages?.data?.[0];
  // JEV/skill loading can take time. Never send an answer to an obsolete turn.
  if (expectedAt && String(top?.from?.id ?? '') !== IG_ID && (!top?.created_time || Date.parse(top.created_time) !== Date.parse(expectedAt))) {
    // Owner 2026-10-19 (l.i.z.a.g.l.l, 19 failed checks in a day): the blogger's newest item is something we never
    // store (a reaction, a like). It is still her word, not a newer turn Diana has missed.
    if (top?.created_time && Date.parse(top.created_time) > Date.parse(expectedAt)) {
      const newer = await env.DB.prepare(`SELECT 1 FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in' AND created_at > ?2 LIMIT 1`)
        .bind(conversationId, expectedAt).first().catch(() => ({}));
      if (!newer) return true;
    }
    return null;
  }
  return top?.from?.id ? String(top.from.id) !== IG_ID : null;
}

/** Refresh a signed attachment URL without sending a message to the blogger. */
/** Instagram marks some photos is_unsupported and never hands them to the API (noza_finds 17.10). */
export const IG_UNSUPPORTED = 'unsupported';

export async function refreshIgAttachments(env: Env, messageId: string): Promise<string | null> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) return null;
  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return null;
  const stored = await env.DB.prepare(`SELECT conversation_id, created_at, from_id FROM ugc_ig_messages WHERE id=?1`).bind(messageId).first<{conversation_id:string;created_at:string;from_id:string|null}>();
  if (!stored) return null;
  // Read the conversation when direct access to the saved message id fails.
  // Use sender + timestamp only when that match is unambiguous.
  let path = `/${encodeURIComponent(stored.conversation_id)}?fields=messages.limit(100){id,created_time,from,is_unsupported,attachments{mime_type,file_url,image_data,video_data}}`;
  for (let n=0;n<4;n++) {
    const r=await graph(path,String(page.body.access_token)); if(!r.ok)return null;
    const data=r.body?.messages?.data ?? r.body?.data ?? [];
    let found=data.find((m:any)=>String(m.id)===messageId);
    if(!found){const matches=data.filter((m:any)=>Date.parse(m.created_time)===Date.parse(stored.created_at) && (!stored.from_id || String(m.from?.id)===stored.from_id));if(matches.length===1)found=matches[0];}
    if(found){
      // Owner 2026-10-18 (kseniya_obzor_wb_ozon, nazarovas2004 and 7 more): Instagram returns some
      // items with no text and no attachments (a like, a reaction, an unsupported sticker). There is
      // nothing to read; '[]' records «confirmed empty» so the reply is not blocked on it.
      // Owner 2026-10-18 (noza_finds): a photo the blogger sent can come back is_unsupported — the
      // Owner sees it in the app, we never get it. That is NOT an empty item: Diana did not see it.
      if(!Array.isArray(found.attachments?.data)){await env.DB.prepare(`UPDATE ugc_ig_messages SET attachments_json='[]' WHERE id=?1`).bind(messageId).run();return found.is_unsupported ? IG_UNSUPPORTED : '[]';}
      const json=JSON.stringify(found.attachments.data);
      await env.DB.prepare(`UPDATE ugc_ig_messages SET attachments_json=?2 WHERE id=?1`).bind(messageId,json).run();
      return json;
    }
    const after=(r.body?.messages?.paging ?? r.body?.paging)?.cursors?.after;
    if(!after || !data.length)break;
    path=`/${encodeURIComponent(stored.conversation_id)}/messages?fields=id,created_time,from,is_unsupported,attachments{mime_type,file_url,image_data,video_data}&limit=100&after=${encodeURIComponent(after)}`;
  }
  return null;
}

/** Repair blank incoming records without asking the creator to resend. Metadata
 * can appear after the initial Graph response, even with no new conversation. */
export async function recoverMissingIgImages(env: Env): Promise<number> {
  const now = Date.now();
  const rows = (await env.DB.prepare(`SELECT m.id,m.conversation_id FROM ugc_ig_messages m
    LEFT JOIN crm_sync_state probe ON probe.key='ig_attachment_probe:'||m.id
    WHERE m.direction='in' AND (m.text IS NULL OR trim(m.text)='')
      AND (m.attachments_json IS NULL OR m.attachments_json='' OR m.attachments_json='[]')
      AND m.created_at>=?1 AND (probe.updated_at IS NULL OR probe.updated_at<?2)
    ORDER BY m.created_at DESC LIMIT 10`)
    .bind(new Date(now - 7 * 86_400_000).toISOString(), now - 30 * 60_000).all<{id:string;conversation_id:string}>()).results ?? [];
  let repaired = 0;
  for (const row of rows) {
    const json = await refreshIgAttachments(env, row.id).catch(() => null);
    if (json && json !== '[]' && json !== IG_UNSUPPORTED) {
      try { await cacheIncomingImages(env, row.id, JSON.parse(json)); await resumeRecoveredIgImage(env,row.conversation_id); repaired++; } catch { /* reader retries */ }
    }
    await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(`ig_attachment_probe:${row.id}`, json === IG_UNSUPPORTED ? 'unsupported_by_instagram' : json && json !== '[]' ? 'metadata_recovered' : 'not_available_yet', now).run();
  }
  return repaired;
}

/** The four scenario cards, one image message each, after a text (Owner 2026-10-16). */
export async function sendIgCards(env: Env, handle: string, urls: string[], opts: { humanAgent?: boolean } = {}): Promise<number> {
  let sent = 0;
  for (const url of urls) {
    const r = await sendIgDirect(env, handle, '', { ...opts, imageUrl: url });
    if (r.ok) sent++;
  }
  return sent;
}

export async function sendIgDirect(env: Env, handle: string, text: string, opts: { humanAgent?: boolean; imageUrl?: string } = {}): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const h = handle.trim().replace(/^@/, '').toLowerCase();
  if (!h) return { ok: false, error: 'no handle' };
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return { ok: false, error: 'META_IG_MESSAGING_TOKEN not set on the Worker' };
  const who = await env.DB.prepare(
    `SELECT from_id FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1 AND from_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`
  ).bind(h).first<{ from_id: string }>();
  if (!who?.from_id) return { ok: false, error: `no Instagram id for ${h}` };
  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return { ok: false, error: `page token: ${page.error}` };
  try {
    const res = await fetch(`${G}/${PAGE_ID}/messages?access_token=${encodeURIComponent(String(page.body.access_token))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // After 24 h Meta accepts a reply only with the HUMAN_AGENT tag (7 days).
      body: JSON.stringify({ recipient: { id: who.from_id }, message: opts.imageUrl ? { attachment: { type: 'image', payload: { url: opts.imageUrl } } } : { text }, ...(opts.humanAgent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : { messaging_type: 'RESPONSE' }) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || body?.error) return { ok: false, error: String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
    // Owner 2026-10-19: Instagram's receipt is the proof of delivery — no receipt, no «delivered».
    const messageId = body?.message_id ? String(body.message_id) : '';
    if (!messageId) return { ok: false, error: 'Instagram не вернул номер сообщения' };
    return { ok: true, messageId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}


const RECENT_CONVERSATIONS = 50;
const SEEN_KEY = 'ig_dm_seen_conversations';

async function recentConversations(pageToken: string, n: number): Promise<Array<{ id: string; updated_time: string }> | null> {
  const out: Array<{ id: string; updated_time: string }> = [];
  let path = `/${PAGE_ID}/conversations?platform=instagram&fields=id,updated_time&limit=${MAX_CONVERSATIONS}`;
  while (out.length < n) {
    const convs = await graph(path, pageToken);
    if (!convs.ok) return out.length ? out : null;
    const data: Array<{ id: string; updated_time: string }> = convs.body?.data ?? [];
    out.push(...data);
    const after = convs.body?.paging?.cursors?.after;
    if (!after || !data.length) break;
    path = `/${PAGE_ID}/conversations?platform=instagram&fields=id,updated_time&limit=${MAX_CONVERSATIONS}&after=${encodeURIComponent(after)}`;
  }
  return out.slice(0, n);
}

async function loadSeen(env: Env): Promise<Record<string, string>> {
  const row = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(SEEN_KEY).first<{ value: string }>().catch(() => null);
  try { const v = JSON.parse(row?.value ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Seen updated_time per conversation for the recent window; an unreadable conversation keeps its old value. */
async function saveSeen(env: Env, map: Record<string, string>, keepOld: Array<[string, string]> = []): Promise<void> {
  const next = { ...map };
  for (const [id, old] of keepOld) { if (old) next[id] = old; else delete next[id]; }
  await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(SEEN_KEY, JSON.stringify(next), Date.now()).run();
}

async function storedLatest(env: Env, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await env.DB.prepare(`SELECT conversation_id c, MAX(created_at) t FROM ugc_ig_messages WHERE conversation_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) GROUP BY conversation_id`)
    .bind(...ids).all<{ c: string; t: string }>().catch(() => ({ results: [] as Array<{ c: string; t: string }> }));
  return Object.fromEntries((rows.results ?? []).map((r) => [r.c, r.t]));
}

export type IgWatchResult = { ok: boolean; activity: boolean; stored: number; incoming: number; error?: string };

/** Owner 2026-10-18 («добавить лёгкую проверку раз в минуту»): one light look — has any Direct
 * conversation changed since the last read? Two Graph calls, no model. Any error → false (the
 * 3/15/30 rule still runs the full lane on time). */
export async function igDmHasNew(env: Env): Promise<boolean> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return false;
  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return false;
  // Owner 2026-10-19: the same 50-conversation comparison as the full read, per conversation.
  const list = await recentConversations(String(page.body.access_token), RECENT_CONVERSATIONS);
  if (!list?.length) return false;
  const seen = await loadSeen(env);
  if (!Object.keys(seen).length) return true;
  return list.some((c) => !seen[c.id] || Date.parse(c.updated_time) > Date.parse(seen[c.id]!));
}

export async function igDmWatch(env: Env): Promise<IgWatchResult> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return { ok: false, activity: false, stored: 0, incoming: 0, error: 'META_IG_MESSAGING_TOKEN not set on the Worker' };

  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return { ok: false, activity: false, stored: 0, incoming: 0, error: `page token: ${page.error}` };
  const pageToken = String(page.body.access_token);
  try { await fillCreatorNames(env, pageToken); } catch { /* names are a convenience; retried next run */ }
  try { await fillCitiesFromReplies(env); } catch { /* retried next run */ }

  // Owner 2026-10-19: «ERP не должен основываться на том, что сообщение прочитано… открывать последние 50».
  // Every check looks at the 50 most recent conversations and compares each with what we last saw in THAT
  // conversation — not one global mark, never the read status (the Owner may read a message first).
  const list = await recentConversations(pageToken, RECENT_CONVERSATIONS);
  if (!list) return { ok: false, activity: false, stored: 0, incoming: 0, error: 'conversations: unreadable' };
  const now = new Date().toISOString();
  const last = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(STATE_KEY).first<{ value: string }>();
  const newest = list.reduce((m, c) => (c.updated_time > m ? c.updated_time : m), '');
  const saveMark = (v: string) => env.DB.prepare(
    `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(STATE_KEY, v, Date.now()).run();
  // First run: take today's inbox as the baseline, no backfill, no activity.
  if (!last?.value) {
    if (newest) await saveMark(newest);
    await saveSeen(env, Object.fromEntries(list.map((c) => [c.id, c.updated_time])));
    return { ok: true, activity: false, stored: 0, incoming: 0 };
  }
  const seen = await loadSeen(env);
  const storedMax = await storedLatest(env, list.map((c) => c.id));
  const baseOf = (id: string) => {
    const v = Math.max(seen[id] ? Date.parse(seen[id]) : 0, storedMax[id] ? Date.parse(storedMax[id]) : 0);
    return v || Date.now() - 7 * 86_400_000;
  };
  const fresh = list.filter((c) => Date.parse(c.updated_time) > baseOf(c.id));
  let stored = 0, incoming = 0;
  const nextSeen: Record<string, string> = { ...seen };
  for (const c of fresh) {
    const since = baseOf(c.id);
    let messagePath = `/${c.id}?fields=messages.limit(100){id,created_time,from,message,attachments{mime_type,file_url,image_data,video_data}}`;
    const cursors = new Set<string>();
    let readOk = true;
    while (messagePath) {
      const msgs = await graph(messagePath, pageToken);
      if (!msgs.ok) { readOk = false; break; }
      const page = msgs.body?.messages ?? msgs.body;
      const messages = page?.data ?? [];
      for (const m of messages) {
        const result = await archiveIgMessage(env, c.id, m, now, since);
        if (result.inserted || result.repaired) stored++;
        if (result.incoming) incoming++;
      }
      const after = page?.paging?.cursors?.after;
      if (!after || !messages.length || messages.some((m: any) => Date.parse(m.created_time) <= since) || cursors.has(after)) break;
      cursors.add(after);
      messagePath = `/${c.id}/messages?fields=id,created_time,from,message,attachments{mime_type,file_url,image_data,video_data}&limit=100&after=${encodeURIComponent(after)}`;
    }
    // A conversation that could not be read stays fresh and is read again next check.
    if (readOk) nextSeen[c.id] = c.updated_time;
  }
  await saveSeen(env, Object.fromEntries(list.map((c) => [c.id, nextSeen[c.id] ?? c.updated_time])), fresh.filter((c) => nextSeen[c.id] !== c.updated_time).map((c) => [c.id, seen[c.id] ?? '']));
  stored += await recoverMissingIgImages(env).catch(() => 0);
  if (newest && Date.parse(newest) > Date.parse(last.value)) await saveMark(newest);
  return { ok: true, activity: stored > 0, stored, incoming };
}
