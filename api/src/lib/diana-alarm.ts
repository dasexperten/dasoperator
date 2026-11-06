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
  const lease = await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES('diana_metadata_tick',?1,?2)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE crm_sync_state.updated_at<=?3`)
    .bind(new Date(now).toISOString(), now, now - 180_000).run();
  if (!lease.meta.changes) return { not_due: true, detected: 0 };
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) throw new Error('instagram_metadata_token_missing');
  const page = await graph(`/${PAGE}?fields=access_token`, token);
  if (!page.access_token) throw new Error('instagram_page_token_missing');
  let after = '', inspected = 0, detected = 0;
  const cursors = new Set<string>();
  do {
    const list = await graph(`/${PAGE}/conversations?platform=instagram&fields=id,updated_time&limit=25${after ? '&after=' + encodeURIComponent(after) : ''}`, page.access_token);
    for (const conversation of list.data ?? []) {
      if (inspected++ >= 50) break;
      const bookmark = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1')
        .bind('diana_metadata_seen:' + conversation.id).first<{ value: string }>();
      if (bookmark?.value === conversation.updated_time) continue;
      // This endpoint explicitly requests metadata only. Diana reads the original content herself.
      const detail = await graph(`/${encodeURIComponent(conversation.id)}?fields=participants,messages.limit(1){id,created_time,from}`, page.access_token);
      const message = detail.messages?.data?.[0];
      if (!message?.id || !message.created_time || !message.from?.id) continue;
      const incoming = ![BRAND, PAGE].includes(String(message.from.id));
      if (incoming) {
        const participant = (detail.participants?.data ?? []).find((p: any) => String(p.id) === String(message.from.id));
        const handle = String(message.from.username ?? participant?.username ?? '').toLowerCase();
        const handled = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1')
          .bind('diana_message_done:' + conversation.id).first<{ value: string }>();
        if (handled?.value !== message.id) {
          const alarm = { handle, cid: String(conversation.id), message_id: String(message.id), at: String(message.created_time), reason: 'new_message', rang_at: new Date(now).toISOString() };
          await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
            .bind(ALARM_PREFIX + conversation.id, JSON.stringify(alarm), now).run();
          detected++;
        }
      }
      await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind('diana_metadata_seen:' + conversation.id, String(conversation.updated_time), now).run();
    }
    after = String(list.paging?.cursors?.after ?? '');
    if (cursors.has(after)) break;
    cursors.add(after);
  } while (after && inspected < 50);
  const channel = env.DIANA_WAKE.get(env.DIANA_WAKE.idFromName('diana'));
  const pushed = await channel.fetch('https://wake.internal/dispatch', { method: 'POST' });
  if (!pushed.ok) throw new Error('diana_dispatch_failed');
  return { inspected: Math.min(inspected, 50), detected, ...(await pushed.json() as object) };
}

export async function pendingDianaMessages(env: Env) {
  const rows = (await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key LIKE ?1 ORDER BY updated_at').bind(ALARM_PREFIX + '%').all<{ value: string }>()).results ?? [];
  return rows.flatMap(row => { try { const alarm = JSON.parse(row.value); return alarm.cid && alarm.message_id ? [alarm] : []; } catch { return []; } });
}
