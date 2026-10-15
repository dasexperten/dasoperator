// Instagram Direct watcher for Diana (Owner 2026-10-15). Reads @dasexperten's
// Direct through the Page with META_IG_MESSAGING_TOKEN (card SECRETS/instagram.md,
// both vaults; never logged) and stores new messages in ugc_ig_messages.
// Read-only toward Instagram: nothing is sent from here.
// Cadence is not decided here — the adaptive runner calls it (3 / 15 / 30 min).
import type { Env } from '../types';

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

export type IgWatchResult = { ok: boolean; activity: boolean; stored: number; incoming: number; error?: string };

export async function igDmWatch(env: Env): Promise<IgWatchResult> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN ?? '';
  if (!token) return { ok: false, activity: false, stored: 0, incoming: 0, error: 'META_IG_MESSAGING_TOKEN not set on the Worker' };

  const page = await graph(`/${PAGE_ID}?fields=access_token`, token);
  if (!page.ok || !page.body?.access_token) return { ok: false, activity: false, stored: 0, incoming: 0, error: `page token: ${page.error}` };
  const pageToken = String(page.body.access_token);

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
