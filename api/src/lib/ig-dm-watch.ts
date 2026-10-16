// Instagram Direct watcher for Diana (Owner 2026-10-15). Reads @dasexperten's
// Direct through the Page with META_IG_MESSAGING_TOKEN (card SECRETS/instagram.md,
// both vaults; never logged) and stores new messages in ugc_ig_messages.
// Sends only one thing: Diana's «перевела» when a payout turns green (sendIgDirect).
// Cadence is not decided here — the adaptive runner calls it (3 / 15 / 30 min).
import type { Env } from '../types';
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
 * One Direct message from @dasexperten to a blogger who has written to us
 * (Owner 2026-10-16: green payout → Diana writes at once). The recipient is the
 * Instagram id from that blogger's own incoming messages; no id → nothing sent.
 */
export async function sendIgDirect(env: Env, handle: string, text: string): Promise<{ ok: boolean; error?: string }> {
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
      body: JSON.stringify({ recipient: { id: who.from_id }, message: { text }, messaging_type: 'RESPONSE' }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || body?.error) return { ok: false, error: String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type IgWatchResult = { ok: boolean; activity: boolean; stored: number; incoming: number; error?: string };

export async function igDmWatch(env: Env): Promise<IgWatchResult> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return { ok: false, activity: false, stored: 0, incoming: 0, error: 'META_IG_MESSAGING_TOKEN not set on the Worker' };

  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return { ok: false, activity: false, stored: 0, incoming: 0, error: `page token: ${page.error}` };
  const pageToken = String(page.body.access_token);
  try { await fillCreatorNames(env, pageToken); } catch { /* names are a convenience; retried next run */ }

  const convs = await graph(`/${PAGE_ID}/conversations?platform=instagram&fields=id,updated_time&limit=${MAX_CONVERSATIONS}`, pageToken);
  if (!convs.ok) return { ok: false, activity: false, stored: 0, incoming: 0, error: `conversations: ${convs.error}` };
  const list: Array<{ id: string; updated_time: string }> = convs.body?.data ?? [];

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
    return { ok: true, activity: false, stored: 0, incoming: 0 };
  }
  const since = Date.parse(last.value);
  const fresh = list.filter((c) => Date.parse(c.updated_time) > since);
  let stored = 0, incoming = 0;
  for (const c of fresh) {
    const msgs = await graph(`/${c.id}?fields=messages.limit(20){id,created_time,from,message,attachments{mime_type,file_url,image_data,video_data}}`, pageToken);
    if (!msgs.ok) return { ok: false, activity: stored > 0, stored, incoming, error: `messages: ${msgs.error}` };
    for (const m of msgs.body?.messages?.data ?? []) {
      if (Date.parse(m.created_time) <= since) continue;
      const out = String(m.from?.id ?? '') === IG_ID;
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO ugc_ig_messages (id, conversation_id, direction, from_id, from_username, text, attachments_json, created_at, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(String(m.id), c.id, out ? 'out' : 'in', m.from?.id ?? null, m.from?.username ?? null,
        typeof m.message === 'string' ? m.message.slice(0, 4000) : null,
        m.attachments?.data?.length ? JSON.stringify(m.attachments.data).slice(0, 4000) : null,
        new Date(Date.parse(m.created_time)).toISOString(), now).run();
      if ((r.meta?.changes ?? 0) === 1) { stored++; if (!out) incoming++; }
    }
  }
  if (newest && Date.parse(newest) > since) await saveMark(newest);
  return { ok: true, activity: stored > 0, stored, incoming };
}
