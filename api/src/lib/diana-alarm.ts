import type { Env } from '../types';

const GRAPH = 'https://graph.facebook.com/v21.0';
const PAGE = '1697038263872226';
const BRAND = '17841466350261166';
export const ALARM_PREFIX = 'diana_round_alarm:';

export function dianaWindow(now: number): boolean {
  const hour = new Date(now + 4 * 3600_000).getUTCHours();
  return hour >= 6 || hour < 2;
}

async function graph(path: string, token: string): Promise<any> {
  const response = await fetch(GRAPH + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`instagram_metadata_http_${response.status}`);
  return response.json();
}

// No message body, attachment, image, model, reply or business-state processing here.
export async function detectDianaMessages(env: Env, now = Date.now()) {
  if (!dianaWindow(now)) return { outside_window: true, detected: 0 };
  const slot = Math.floor(now / 180_000);
  const lease = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_metadata_tick_v2',?1,?2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE CAST(crm_sync_state.value AS INTEGER)<?3`)
    .bind(String(slot), now, slot).run();
  if (!lease.meta.changes) return { not_due: true, detected: 0 };
  let inspected = 0, detected = 0, errors = 0;
  try {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) throw new Error('instagram_metadata_token_missing');
  const page = await graph(`/${PAGE}?fields=access_token`, token);
  if (!page.access_token) throw new Error('instagram_page_token_missing');
  let after = '';
  const cursors = new Set<string>();
  do {
    const list = await graph(`/${PAGE}/conversations?platform=instagram&fields=id,updated_time&limit=25${after ? '&after=' + encodeURIComponent(after) : ''}`, page.access_token);
    for (const conversation of list.data ?? []) {
      inspected++;
      try {
      const bookmark = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1')
        .bind('diana_metadata_seen:v2:' + conversation.id).first<{ value: string }>();
      if (bookmark?.value === conversation.updated_time) continue;
      // This endpoint explicitly requests metadata only. Diana reads the original content herself.
      const detail = await graph(`/${encodeURIComponent(conversation.id)}?fields=participants,messages.limit(100){id,created_time,from}`, page.access_token);
      const frontier = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1')
        .bind('diana_metadata_message_seen:' + conversation.id).first<{ value: string }>();
      let messagePage = detail.messages, message: any = null, reached = false;
      const newestId = messagePage?.data?.[0]?.id;
      const messageCursors = new Set<string>();
      while (messagePage?.data?.length && !reached) {
        for (const candidate of messagePage.data) {
          if (candidate.id === frontier?.value) { reached = true; break; }
          if (!message && candidate.id && candidate.created_time && candidate.from?.id && ![BRAND, PAGE].includes(String(candidate.from.id))) message = candidate;
        }
        // Initial scan needs the newest incoming, including one followed by Owner's outgoing.
        if (!frontier && message) break;
        const cursor = messagePage.paging?.next && messagePage.paging?.cursors?.after;
        if (reached || !cursor || messageCursors.has(cursor)) break;
        messageCursors.add(cursor);
        messagePage = await graph(`/${encodeURIComponent(conversation.id)}/messages?fields=id,created_time,from&limit=100&after=${encodeURIComponent(cursor)}`, page.access_token);
      }
      if (message) {
        const participant = (detail.participants?.data ?? []).find((p: any) => String(p.id) === String(message.from.id));
        const handle = String(message.from.username ?? participant?.username ?? '').toLowerCase();
        const handled = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1')
          .bind('diana_message_done:' + conversation.id).first<{ value: string }>();
        if (handled?.value !== message.id) {
          const alarm = { handle, cid: String(conversation.id), message_id: String(message.id), event_id: 'message:' + message.id, at: String(message.created_time), reason: 'new_message', rang_at: new Date(now).toISOString() };
          await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .bind(ALARM_PREFIX + conversation.id, JSON.stringify(alarm), now).run();
          detected++;
        }
      }
      if (newestId) await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind('diana_metadata_message_seen:' + conversation.id, String(newestId), now).run();
      await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind('diana_metadata_seen:v2:' + conversation.id, String(conversation.updated_time), now).run();
      } catch { errors++; } // Leave this conversation's checkpoint untouched; continue others.
    }
    after = list.paging?.next ? String(list.paging?.cursors?.after ?? '') : '';
    if (cursors.has(after)) break;
    cursors.add(after);
  } while (after);
  } catch { errors++; } // Existing durable signals must still reach Diana during Graph outages.
  const channel = env.DIANA_WAKE.get(env.DIANA_WAKE.idFromName('diana'));
  const pushed = await channel.fetch('https://wake.internal/dispatch', { method: 'POST' });
  if (!pushed.ok) throw new Error('diana_dispatch_failed');
  return { inspected, detected, errors, ...(await pushed.json() as object) };
}

export async function pendingDianaMessages(env: Env) {
  const rows = (await env.DB.prepare("SELECT key,value,updated_at FROM crm_sync_state WHERE key LIKE ?1 OR key LIKE 'diana_action_pending:%' ORDER BY updated_at").bind(ALARM_PREFIX + '%').all<{ key: string; value: string; updated_at: number }>()).results ?? [];
  const pending = [];
  for (const row of rows) {
    try {
      const alarm = JSON.parse(row.value);
      if (!alarm.cid && row.key.startsWith(ALARM_PREFIX)) alarm.cid = row.key.slice(ALARM_PREFIX.length);
      if (!alarm.cid) continue;
      if (!alarm.event_id) {
        alarm.message_id ??= null; // Legacy signal: Diana must resolve the original; never invent a message ID.
        alarm.event_id = alarm.message_id ? 'message:' + alarm.message_id : 'legacy:' + alarm.cid + ':' + row.updated_at;
        const saved = await env.DB.prepare('UPDATE crm_sync_state SET value=?1 WHERE key=?2 AND value=?3').bind(JSON.stringify(alarm),row.key,row.value).run();
        if (!saved.meta.changes) continue; // A newer signal arrived; leave it for the next delivery.
      }
      pending.push({...alarm, queue_key: row.key});
    } catch { /* Unreadable records stay durable for diagnosis. */ }
  }
  return pending;
}

export async function acknowledgeDianaEvent(env: Env, event: {cid: string; message_id: string | null; event_id: string}) {
  const key = event.event_id.startsWith('action:') ? 'diana_action_pending:' + event.event_id : ALARM_PREFIX + event.cid;
  const rows = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_event_done:' + event.event_id).first<{value:string}>();
  let receipt: any;
  try { receipt = JSON.parse(rows?.value ?? 'null'); } catch { return false; }
  if (!receipt || receipt.verified !== true || receipt.event_id !== event.event_id || receipt.cid !== event.cid || receipt.message_id !== event.message_id || typeof receipt.proof !== 'string' || !receipt.proof.trim()) return false;
  // Both statements execute atomically; an older completion cannot overwrite a newer alarm.
  const match = `key=?1 AND json_valid(value) AND json_extract(value,'$.message_id') IS ?2 AND json_extract(value,'$.event_id')=?3`;
  const statements = [];
  if (event.event_id === 'message:' + event.message_id) statements.push(env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?4,?2,?5 FROM crm_sync_state WHERE ${match} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key,event.message_id,event.event_id,'diana_message_done:'+event.cid,Date.now()));
  statements.push(env.DB.prepare(`DELETE FROM crm_sync_state WHERE ${match}`).bind(key,event.message_id,event.event_id));
  const results = await env.DB.batch(statements);
  return !!results.at(-1)?.meta.changes;
}
