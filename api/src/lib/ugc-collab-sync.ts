import type { Env } from '../types';
import { decideCollab, postCode } from './ugc-collab-status.mjs';

// Owner 2026-11-07 (Marika): the handshake in the bottom-right corner of a post chip.
// Two Graph lists of our own Instagram account, read with the Direct key once an hour:
// accepted collaborative media (black) and open collaboration invites (grey).
// Both lists must come back whole, or nothing is written: a failed read never wipes a mark.

const G = 'https://graph.facebook.com/v22.0';
const IG_USER = '17841466350261166'; // @dasexperten business account behind Page 1697038263872226
const MAX_PAGES = 30;

async function pages(first: string, token: string): Promise<any[] | null> {
  const out: any[] = [];
  let url: string | null = `${first}${first.includes('?') ? '&' : '?'}limit=100`;
  for (let n = 0; url && n < MAX_PAGES; n++) {
    try {
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const body = await res.json() as any;
      if (!res.ok || body?.error) return null;
      out.push(...(body.data ?? []));
      url = body.paging?.next ?? null;
    } catch { return null; }
  }
  return out;
}

export async function syncCollabStatus(env: Env): Promise<{ confirmed: number; requested: number; changed: number; error?: string }> {
  const token = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
  if (!token) return { confirmed: 0, requested: 0, changed: 0, error: 'META_IG_MESSAGING_TOKEN not set' };
  const [media, invites] = await Promise.all([
    pages(`${G}/${IG_USER}/collaborative_media?fields=permalink`, token),
    pages(`${G}/${IG_USER}/collaboration_invites?fields=media_owner_username`, token),
  ]);
  if (!media || !invites) return { confirmed: 0, requested: 0, changed: 0, error: 'Instagram collab lists not read' };
  const codes = new Set(media.map((m) => postCode(m.permalink)).filter((c): c is string => !!c));
  const open = new Map<string, number>();
  for (const i of invites) {
    const h = String(i.media_owner_username ?? '').toLowerCase();
    if (h) open.set(h, (open.get(h) ?? 0) + 1);
  }
  const rows = (await env.DB.prepare(
    `SELECT c.id, c.content_url, c.published_at, c.collab_status, p.normalized_handle handle
       FROM ugc_content c JOIN ugc_creator_platforms p ON p.id = c.creator_platform_id
      WHERE c.content_url LIKE '%instagram.com/%'`
  ).all<{ id: string; content_url: string; published_at: string | null; collab_status: string | null; handle: string | null }>()).results ?? [];
  const decided = decideCollab(rows, codes, open);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let confirmed = 0, requested = 0;
  for (const row of rows) {
    const status = decided.get(row.id) ?? null;
    if (status === 'confirmed') confirmed++;
    if (status === 'requested') requested++;
    if ((row.collab_status ?? null) !== status) {
      statements.push(env.DB.prepare(`UPDATE ugc_content SET collab_status=?2, collab_checked_at=?3 WHERE id=?1`).bind(row.id, status, now));
    }
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return { confirmed, requested, changed: statements.length };
}
