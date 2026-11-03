// Owner 2026-10-17: links bloggers send in Direct must reach the ERP and be checked.
// Owner 2026-11-03 (DH-LAW-261103-02, @my.live_2026 sent someone else's reel with no link to our product):
// the ERP is an alarm, not a postman. A link in Direct is never added to «Контент» and never moves the
// stage by itself. It only rings Diana; she opens the reel and adds it only if the blogger is the author
// AND our product is in it. A link she has judged carries diana_reel_checked:<code> and never rings again.
import type { Env } from '../types';

const READ_BATCH = 50; // Stay below D1's bound-parameter limit.
const LINK = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/g;
export const REEL_CHECKED_KEY = (code: string) => `diana_reel_checked:${code}`;
const ALARM_KEY = (cid: string) => `diana_round_alarm:${cid}`;

export async function captureDmLinks(env: Env): Promise<{ added: number }> {
  const rows = (await env.DB.prepare(
    `SELECT conversation_id, lower(from_username) h, text, created_at FROM ugc_ig_messages
      WHERE direction='in' AND text LIKE '%instagram.com/%' AND from_username IS NOT NULL
      ORDER BY created_at DESC LIMIT 400`
  ).all<{ conversation_id: string; h: string; text: string; created_at: string }>()).results ?? [];
  const links = rows.flatMap(r => [...r.text.matchAll(LINK)].map(m => ({ ...r, kind: m[1] === 'p' ? 'p' : 'reel', code: m[2]! })));
  if (!links.length) return { added: 0 };
  const codes = [...new Set(links.map(link => link.code))];
  const settled = new Set<string>();
  for (let offset = 0; offset < codes.length; offset += READ_BATCH) {
    const batch = codes.slice(offset, offset + READ_BATCH);
    const existing = (await env.DB.prepare(`SELECT content_url FROM ugc_content WHERE ${batch.map((_, i) => `content_url LIKE ?${i + 1}`).join(' OR ')}`)
      .bind(...batch.map(code => `%/${code}%`)).all<{ content_url: string }>()).results ?? [];
    // Parse the actual code: a prefix (or LIKE's underscore wildcard) is not proof of the same publication.
    for (const row of existing) for (const match of row.content_url.matchAll(LINK)) settled.add(match[2]!);
    const judged = (await env.DB.prepare(`SELECT key FROM crm_sync_state WHERE key IN (${batch.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...batch.map(REEL_CHECKED_KEY)).all<{ key: string }>()).results ?? [];
    for (const row of judged) settled.add(row.key.slice('diana_reel_checked:'.length));
  }
  const byChat = new Map<string, { h: string; at: string; urls: Set<string> }>();
  for (const r of links) {
    if (settled.has(r.code)) continue;
    const entry = byChat.get(r.conversation_id) ?? { h: r.h, at: r.created_at, urls: new Set<string>() };
    entry.urls.add(`https://www.instagram.com/${r.kind}/${r.code}/`);
    if (r.created_at > entry.at) entry.at = r.created_at;
    byChat.set(r.conversation_id, entry);
  }
  let rung = 0;
  for (const [cid, entry] of byChat) {
    const prior = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(ALARM_KEY(cid)).first<{ value: string }>();
    let value: Record<string, any> = {};
    try { value = JSON.parse(prior?.value ?? '{}') ?? {}; } catch { value = {}; }
    const known = new Set<string>(Array.isArray(value.links) ? value.links : []);
    const fresh = [...entry.urls].filter(u => !known.has(u));
    if (!fresh.length) continue;
    const reasons = new Set<string>(String(value.reason ?? '').split(',').filter(Boolean)); reasons.add('reel_link');
    const next = { ...value, handle: value.handle ?? entry.h, cid, at: value.at && value.at > entry.at ? value.at : entry.at,
      reason: [...reasons].join(','), links: [...known, ...fresh], rang_at: new Date().toISOString() };
    await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .bind(ALARM_KEY(cid), JSON.stringify(next), Date.now()).run();
    rung++;
  }
  return { added: rung };
}
