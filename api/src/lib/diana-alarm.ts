import type { Env } from '../types';

const GRAPH = 'https://graph.facebook.com/v21.0';
const PAGE = '1697038263872226';
const BRAND = '17841466350261166';
export const ALARM_PREFIX = 'diana_round_alarm:';
const DIANA_SCAN_PAGES = 8; // newest 200 chats, 25 per page

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
  const owner = crypto.randomUUID();
  const lock = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_metadata_scan',?1,?2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE crm_sync_state.updated_at<?3`)
    .bind(owner,Date.now(),Date.now()-180_000).run();
  if (!lock.meta.changes) return { scan_running: true, detected: 0 };
  const scanStarted = Date.now();
  let inspected = 0, detected = 0, errors = 0, early_dispatched = 0, ownershipLost = false;
  const channel = env.DIANA_WAKE.get(env.DIANA_WAKE.idFromName('diana'));
  const dispatch = async (eventId?: string) => {
    const response = await channel.fetch('https://wake.internal/dispatch', { method: 'POST',
      ...(eventId ? {headers: {'Content-Type':'application/json'}, body: JSON.stringify({priority_event_id:eventId})} : {}) });
    if (!response.ok) throw new Error('diana_dispatch_failed');
    return await response.json() as {dispatched?: boolean; [key:string]: unknown};
  };
  try {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) throw new Error('instagram_metadata_token_missing');
  const page = await graph(`/${PAGE}?fields=access_token`, token);
  if (!page.access_token) throw new Error('instagram_page_token_missing');
  const records = (await env.DB.prepare("SELECT key,value FROM crm_sync_state WHERE key LIKE 'diana_message_done:%'").all<{key:string;value:string}>()).results ?? [];
  const known = new Map(records.map(row => [row.key,row.value]));
  // Owner 2026-11-07: ERP is only an alarm, and the alarm is a check of STATE, not of news. Every tick it looks at the
  // newest 200 chats (8 pages of 25), nothing deeper. A chat is waiting when its newest message is the blogger's and
  // Diana has no verified receipt (diana_message_done) for exactly that message. A waiting chat always has an alarm,
  // however long ago its message came and whatever an earlier tick saw, so nothing missed once can stay missed.
  // A chat whose newest message is ours has nothing waiting, so its alarm is cleared.
  let after = '';
  for (let pageNo = 0; pageNo < DIANA_SCAN_PAGES; pageNo++) {
    const renewed = await env.DB.prepare("UPDATE crm_sync_state SET updated_at=?1 WHERE key='diana_metadata_scan' AND value=?2").bind(Date.now(),owner).run();
    if (!renewed.meta.changes) throw new Error('metadata_scan_ownership_lost');
    const list = await graph(`/${PAGE}/conversations?platform=instagram&fields=id,updated_time,participants,messages.limit(3){id,created_time,from}&limit=25${after ? '&after=' + encodeURIComponent(after) : ''}`, page.access_token);
    for (const conversation of list.data ?? []) {
      inspected++;
      try {
        const newest = conversation.messages?.data?.[0];
        if (newest?.id && newest.created_time && newest.from?.id) {
          if ([BRAND, PAGE].includes(String(newest.from.id))) {
            // Our message is last: nothing is waiting in this chat.
            await env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1').bind(ALARM_PREFIX + conversation.id).run();
          } else if (known.get('diana_message_done:' + conversation.id) !== newest.id) {
            const participant = (conversation.participants?.data ?? []).find((p: any) => String(p.id) === String(newest.from.id));
            const handle = String(newest.from.username ?? participant?.username ?? '').toLowerCase();
            const display_name = String(newest.from.name ?? participant?.name ?? '');
            const alarm = { handle, display_name, cid: String(conversation.id), message_id: String(newest.id), event_id: 'message:' + newest.id, at: String(newest.created_time), reason: 'new_message', rang_at: new Date(now).toISOString() };
            // An alarm already ringing for this very message is left as it is (its first ring time stays).
            const raised = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
              WHERE NOT json_valid(crm_sync_state.value) OR json_extract(crm_sync_state.value,'$.message_id') IS NOT ?4`)
              .bind(ALARM_PREFIX + conversation.id, JSON.stringify(alarm), now, String(newest.id)).run();
            if (raised.meta.changes) {
              detected++;
              // Deliver as soon as the durable event exists; a busy or disconnected Diana
              // leaves it in the queue for a later dispatch. Never interrupt the scan.
              try { if ((await dispatch(alarm.event_id)).dispatched) early_dispatched++; } catch { errors++; }
            }
          }
        }
      } catch { errors++; }
    }
    after = list.paging?.next ? String(list.paging?.cursors?.after ?? '') : '';
    if (!after) break;
    if (Date.now() - scanStarted >= 90_000 && pageNo + 1 < DIANA_SCAN_PAGES) { errors++; break; }
  }
  // Preserve outstanding alarms even when conversations move beyond the scan window.

  } catch {
    errors++;
    await env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_metadata_scan_cursor'").run();
  } // Existing durable signals still reach Diana; invalid cursors are retried from the newest page.
  await env.DB.prepare("DELETE FROM crm_sync_state WHERE key='diana_metadata_scan' AND value=?1").bind(owner).run();
  const pushed = await dispatch();
  return { inspected, detected, errors, early_dispatched, ...pushed };
}

// The 10:00 Yerevan batch opens reminders for this day; incoming messages and payout notices remain independent.
export const VIDEO_REMINDER_BATCH_KEY = 'diana_video_reminder_batch_day';
export function yerevanDay(now = Date.now()) { return new Date(now + 4 * 3600_000).toISOString().slice(0, 10); }
export async function pendingDianaMessages(env: Env, now = Date.now()) {
  const batch = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(VIDEO_REMINDER_BATCH_KEY).first<{value:string}>();
  const videoBatchOpen = batch?.value === yerevanDay(now);
  const rows = (await env.DB.prepare("SELECT key,value,updated_at FROM crm_sync_state WHERE key LIKE ?1 OR key LIKE 'diana_action_pending:%' ORDER BY updated_at").bind(ALARM_PREFIX + '%').all<{ key: string; value: string; updated_at: number }>()).results ?? [];
  const pending = [];
  for (const row of rows) {
    try {
      const alarm = JSON.parse(row.value);
      if (alarm.task === 'video_reminder' && !videoBatchOpen) continue;
      // Existing events from the old three-day rule stay pending but must not
      // wake Diana for a reminder before five full days have passed.
      const paidAt = alarm.task === 'video_reminder' ? Date.parse(String(alarm.paid_at ?? '')) : NaN;
      if (Number.isFinite(paidAt) && now - paidAt < 5 * 86_400_000) continue;
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
