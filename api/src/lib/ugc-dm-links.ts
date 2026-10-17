// Owner 2026-10-17: links bloggers send in Direct must reach the ERP and be checked.
// Every Instagram post or reel link in an incoming message becomes a ugc_content row;
// refreshContentMetrics (same lane) then reads it first — alive or removed, views, likes, comments.
import type { Env } from '../types';
import { ensureCreator } from './ig-dm-reply';

const PER_RUN = 40;
const LINK = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/g;

export async function captureDmLinks(env: Env): Promise<{ added: number }> {
  const rows = (await env.DB.prepare(
    `SELECT conversation_id, lower(from_username) h, text, created_at FROM ugc_ig_messages
      WHERE direction='in' AND text LIKE '%instagram.com/%' AND from_username IS NOT NULL
      ORDER BY created_at DESC LIMIT 400`
  ).all<{ conversation_id: string; h: string; text: string; created_at: string }>()).results ?? [];
  let added = 0;
  for (const r of rows) {
    for (const m of r.text.matchAll(LINK)) {
      if (added >= PER_RUN) return { added };
      const kind = m[1] === 'p' ? 'p' : 'reel';
      const code = m[2]!;
      const known = await env.DB.prepare(`SELECT 1 FROM ugc_content WHERE content_url LIKE ?1 LIMIT 1`).bind(`%/${code}%`).first();
      if (known) continue;
      const { cid, pid } = await ensureCreator(env, r.h);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO ugc_content (id, creator_id, creator_platform_id, content_url, content_type, source_workbook, source_sheet, link_check_note, imported_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'instagram_dm', ?6, ?7, ?8, ?8) ON CONFLICT(id) DO NOTHING`
      ).bind(`ugcc_dm_${code}`, cid, pid, `https://www.instagram.com/${kind}/${code}/`, kind === 'p' ? 'post' : 'reel', r.conversation_id, `Прислано в Direct ${r.created_at.slice(0, 10)}`, now).run();
      added++;
    }
  }
  return { added };
}
