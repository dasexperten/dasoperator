// Owner 2026-10-17: links bloggers send in Direct must reach the ERP and be checked.
// Every Instagram post or reel link in an incoming message becomes a ugc_content row;
// refreshContentMetrics (same lane) then reads it first — alive or removed, views, likes, comments.
import type { Env } from '../types';
import { ensureCreator, nextStage } from './ig-dm-reply';

const PER_RUN = 40;
const READ_BATCH = 50; // Stay below D1's bound-parameter limit.
const LINK = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/g;
type Creator = { cid: string; pid: string; stage: string | null };

export async function captureDmLinks(env: Env): Promise<{ added: number }> {
  const rows = (await env.DB.prepare(
    `SELECT conversation_id, lower(from_username) h, text, created_at FROM ugc_ig_messages
      WHERE direction='in' AND text LIKE '%instagram.com/%' AND from_username IS NOT NULL
      ORDER BY created_at DESC LIMIT 400`
  ).all<{ conversation_id: string; h: string; text: string; created_at: string }>()).results ?? [];
  const links = rows.flatMap(r => [...r.text.matchAll(LINK)].map(m => ({ ...r, kind: m[1] === 'p' ? 'p' : 'reel', code: m[2]! })));
  if (!links.length) return { added: 0 };
  const codes = [...new Set(links.map(link => link.code))];
  const known = new Set<string>();
  for (let offset = 0; offset < codes.length; offset += READ_BATCH) {
    const batch = codes.slice(offset, offset + READ_BATCH);
    const existing = (await env.DB.prepare(`SELECT content_url FROM ugc_content WHERE ${batch.map((_, i) => `content_url LIKE ?${i + 1}`).join(' OR ')}`)
      .bind(...batch.map(code => `%/${code}%`)).all<{ content_url: string }>()).results ?? [];
    // Parse the actual code: a prefix (or LIKE's underscore wildcard) is not
    // proof that this exact publication has already been imported.
    for (const row of existing) for (const match of row.content_url.matchAll(LINK)) known.add(match[2]!);
  }
  const creators = new Map<string, Creator>();
  const handles = [...new Set(links.map(link => link.h))];
  for (let offset = 0; offset < handles.length; offset += READ_BATCH) {
    const batch = handles.slice(offset, offset + READ_BATCH);
    const existing = (await env.DB.prepare(`SELECT p.normalized_handle h, p.creator_id cid, p.id pid, c.lifecycle_stage stage
      FROM ugc_creator_platforms p LEFT JOIN ugc_creators c ON c.id=p.creator_id
      WHERE p.normalized_handle IN (${batch.map((_, i) => `?${i + 1}`).join(',')}) AND p.platform IN ('instagram','other')
      ORDER BY CASE WHEN p.platform='instagram' THEN 0 ELSE 1 END, p.id`)
      .bind(...batch).all<Creator & { h: string }>()).results ?? [];
    for (const creator of existing) if (!creators.has(creator.h)) creators.set(creator.h, creator);
  }
  const staged = new Set<string>();
  let added = 0;
  for (const r of links) {
    if (added >= PER_RUN) return { added };
    const { kind, code } = r;
    let creator = creators.get(r.h);
    if (!creator) {
      const identity = await ensureCreator(env, r.h);
      // A concurrent importer may have created this handle since the preload.
      const row = await env.DB.prepare(`SELECT lifecycle_stage s FROM ugc_creators WHERE id=?1`).bind(identity.cid).first<{ s: string | null }>();
      creator = { ...identity, stage: row?.s ?? null };
      creators.set(r.h, creator);
    }
    const { cid, pid } = creator;
    // Owner 2026-10-21 (mira_28_25): a reel in Direct means the blogger has posted — the stage follows the fact.
    if (!staged.has(cid)) { await advanceToPosted(env, creator); staged.add(cid); }
    if (known.has(code)) continue;
    const now = Date.now();
    const inserted = await env.DB.prepare(
      `INSERT INTO ugc_content (id, creator_id, creator_platform_id, content_url, content_type, source_workbook, source_sheet, link_check_note, imported_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'instagram_dm', ?6, ?7, ?8, ?8) ON CONFLICT(id) DO NOTHING`
    // Owner 2026-10-21: the date is when the blogger sent the reel, not when the ERP found it — an old reel must not look like today's contact.
    ).bind(`ugcc_dm_${code}`, cid, pid, `https://www.instagram.com/${kind}/${code}/`, kind === 'p' ? 'post' : 'reel', r.conversation_id, `Прислано в Direct ${r.created_at.slice(0, 10)}`, Date.parse(r.created_at) || now).run();
    known.add(code);
    added += inserted.meta?.changes ?? 0;
  }
  return { added };
}

async function advanceToPosted(env: Env, creator: Creator): Promise<void> {
  if (!nextStage(creator.stage, 'posted')) return;
  // Do not overwrite a newer gold/refused/etc. state written after the preload.
  await env.DB.prepare(`UPDATE ugc_creators SET lifecycle_stage='posted', updated_at=?2 WHERE id=?1 AND lifecycle_stage IS ?3`)
    .bind(creator.cid, Date.now(), creator.stage).run();
}
