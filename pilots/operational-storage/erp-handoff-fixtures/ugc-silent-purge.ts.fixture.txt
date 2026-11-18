import type { Env } from '../types';

// Owner 2026-11-05: an Instagram blogger appears in the ERP once Diana writes to her. If she stays
// silent or ignores us for a week (no reply at all, status empty or silent), her card is deleted —
// not archived. A blogger who answered, even with a polite refusal, keeps her card.
// A small do-not-contact marker (ugc_purged:instagram:<handle>) stays so Diana never invites her twice.

const WEEK_MS = 7 * 24 * 3600 * 1000;
const BATCH = 200;

export const PURGE_MARKER_PREFIX = 'ugc_purged:instagram:';

export async function runUgcSilentPurge(env: Env, now = Date.now()): Promise<{ deleted: number; handles: string[] }> {
  const cutoff = now - WEEK_MS;
  const rows = await env.DB.prepare(`
    SELECT c.id, p.normalized_handle handle
      FROM ugc_creators c
      JOIN ugc_creator_platforms p ON p.creator_id = c.id AND p.platform = 'instagram'
     WHERE COALESCE(c.lifecycle_stage, '') IN ('', 'silent')
       AND c.created_at <= ?1
       AND NOT EXISTS (SELECT 1 FROM ugc_ig_messages m WHERE m.direction = 'in' AND LOWER(COALESCE(m.from_username, '')) = LOWER(p.normalized_handle))
       AND NOT EXISTS (SELECT 1 FROM ugc_payouts y WHERE y.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_source_records r WHERE r.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_content k WHERE k.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_collaborations k WHERE k.creator_id = c.id AND COALESCE(k.status, '') NOT IN ('', 'found', 'silent'))
     LIMIT ?2`).bind(cutoff, BATCH).all<{ id: string; handle: string }>();
  const list = rows.results ?? [];
  if (!list.length) return { deleted: 0, handles: [] };

  const statements: D1PreparedStatement[] = [];
  for (const row of list) {
    statements.push(env.DB.prepare(
      `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(`${PURGE_MARKER_PREFIX}${row.handle}`, JSON.stringify({ at: now, reason: 'silent_7d' }), now));
    statements.push(env.DB.prepare(
      `DELETE FROM ugc_handle_history WHERE creator_platform_id IN (SELECT id FROM ugc_creator_platforms WHERE creator_id = ?1)`
    ).bind(row.id));
    statements.push(env.DB.prepare(`DELETE FROM ugc_collaborations WHERE creator_id = ?1`).bind(row.id));
    statements.push(env.DB.prepare(`DELETE FROM ugc_creator_platforms WHERE creator_id = ?1`).bind(row.id));
    statements.push(env.DB.prepare(`DELETE FROM ugc_creators WHERE id = ?1`).bind(row.id));
  }
  await env.DB.batch(statements);
  return { deleted: list.length, handles: list.map((r) => r.handle) };
}
