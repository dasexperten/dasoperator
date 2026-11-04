import type { Env } from '../types';
import { render } from './ugc-diagnose';
import { parseInstagramProfile } from './ugc-blogger-profile-parse.mjs';
import { decideRename, instagramPostCode, parsePostOwner } from './ugc-rename-parse.mjs';

// Owner 2026-11-04: a greyed Instagram creator may simply have changed the account name while our
// reels stay live. Three checks, in order: the permanent account number from Direct (Graph),
// the author of each of our reels, the profile under the old name. A new name goes on the card at
// once and the old one into ugc_handle_history. Only positive evidence changes the status:
// a creator nobody can find stays greyed, with the date of the check in the note.

type Row = { id: string; creator_id: string; normalized_handle: string; handle: string };
export type RenameResult = { profile_id: string; old_handle: string; outcome: 'renamed' | 'alive' | 'gone' | 'conflict'; new_handle?: string; evidence: string };

async function graph(path: string, token: string): Promise<any | null> {
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as any;
    return response.ok && !data?.error ? data : null;
  } catch { return null; }
}

export async function checkInstagramRenames(env: Env, profileId?: string, limit = 20): Promise<{ attempted: number; renamed: number; alive: number; gone: number; conflict: number; results: RenameResult[]; busy?: boolean }> {
  const lease = crypto.randomUUID();
  const lock = 'lock:ugc-rename-check';
  const claimed = await env.DB.prepare(`INSERT INTO erp_job_claims (worker,slot,lease_until) VALUES (?,?,?)
    ON CONFLICT(worker) DO UPDATE SET slot=excluded.slot,lease_until=excluded.lease_until WHERE erp_job_claims.lease_until<=?
    RETURNING worker`).bind(lock, lease, Date.now() + 15 * 60_000, Date.now()).first();
  const empty = { attempted: 0, renamed: 0, alive: 0, gone: 0, conflict: 0, results: [] as RenameResult[] };
  if (!claimed) return { ...empty, busy: true };
  try {
    const rows = (await env.DB.prepare(`SELECT id, creator_id, normalized_handle, handle FROM ugc_creator_platforms
      WHERE platform='instagram' AND (?1 IS NOT NULL AND id=?1 OR ?1 IS NULL AND availability_status='unavailable'
        AND (rename_checked_at IS NULL OR rename_checked_at < ?2))
      ORDER BY rename_checked_at IS NOT NULL, rename_checked_at ASC LIMIT ?3`)
      .bind(profileId ?? null, new Date(Date.now() - 20 * 3_600_000).toISOString(), Math.min(50, Math.max(1, limit)))
      .all<Row>()).results ?? [];
    const messagingToken = (env as unknown as { META_IG_MESSAGING_TOKEN?: string }).META_IG_MESSAGING_TOKEN;
    const pageToken = messagingToken ? (await graph('1697038263872226?fields=access_token', messagingToken))?.access_token : null;
    const out = { ...empty };
    const deadline = Date.now() + 10 * 60_000;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      out.attempted++;
      const old = row.normalized_handle.toLowerCase();
      // 1. Permanent account number from any Direct message under this or an earlier name.
      const igsid = (await env.DB.prepare(`SELECT from_id FROM ugc_ig_messages WHERE direction='in' AND from_id IS NOT NULL
          AND (lower(from_username)=?1 OR lower(from_username) IN (SELECT old_handle FROM ugc_handle_history WHERE creator_platform_id=?2))
          ORDER BY created_at DESC LIMIT 1`).bind(old, row.id).first<{ from_id: string }>())?.from_id ?? null;
      const official = pageToken && igsid ? await graph(`${encodeURIComponent(igsid)}?fields=username`, pageToken) : null;
      const graphUsername = typeof official?.username === 'string' ? official.username : null;
      // 2. Author of each of our reels (up to three, newest first).
      const postOwners: string[] = [];
      if (!graphUsername || graphUsername.toLowerCase() === old) {
        const links = (await env.DB.prepare(`SELECT content_url FROM ugc_content WHERE creator_platform_id=? AND content_url LIKE '%instagram.com%'
            ORDER BY COALESCE(published_at,'') DESC LIMIT 6`).bind(row.id).all<{ content_url: string }>()).results ?? [];
        for (const link of links) {
          if (postOwners.length >= 3 || Date.now() > deadline) break;
          const code = instagramPostCode(link.content_url);
          if (!code) continue;
          const html = await render(env, `https://www.instagram.com/p/${code}/`, 'domcontentloaded', 20_000).catch(() => null);
          const owner = parsePostOwner(html);
          if (owner) { postOwners.push(owner); if (owner !== old) break; }
        }
      }
      // 3. The profile under the old name.
      let profileAlive = false;
      if (!graphUsername && !postOwners.length && /^[A-Za-z0-9_.]{1,30}$/.test(old)) {
        const html = await render(env, `https://www.instagram.com/${encodeURIComponent(old)}/`, 'domcontentloaded', 20_000).catch(() => null);
        const parsed = html ? parseInstagramProfile(html, old) : null;
        profileAlive = Boolean(parsed && (parsed.followers != null || parsed.posts != null));
      }
      const decision = decideRename(old, { graphUsername, postOwners, profileAlive });
      const now = new Date().toISOString();
      const day = now.slice(0, 10);
      if (decision.outcome === 'renamed') {
        const taken = await env.DB.prepare("SELECT id FROM ugc_creator_platforms WHERE platform='instagram' AND normalized_handle=? AND id<>?").bind(decision.handle, row.id).first<{ id: string }>();
        if (taken) {
          await env.DB.prepare('UPDATE ugc_creator_platforms SET rename_checked_at=?, availability_note=? WHERE id=?')
            .bind(now, `${day}: сменил имя на @${decision.handle} (${decision.evidence}), но это имя уже есть у другой карточки — нужна склейка`, row.id).run();
          out.conflict++;
          out.results.push({ profile_id: row.id, old_handle: old, outcome: 'conflict', new_handle: decision.handle, evidence: decision.evidence });
          continue;
        }
        const note = `${day}: сменил имя @${old} → @${decision.handle} (${decision.evidence})`;
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO ugc_handle_history (id, creator_platform_id, platform, old_handle, new_handle, evidence, changed_at) VALUES (?,?,?,?,?,?,?)`)
            .bind(crypto.randomUUID(), row.id, 'instagram', old, decision.handle, decision.evidence, now),
          env.DB.prepare(`UPDATE ugc_creator_platforms SET handle=?2, normalized_handle=?2, profile_url=?3, availability_status='available',
              availability_checked_at=?4, availability_note=?5, rename_checked_at=?4, profile_attempted_at=NULL, updated_at=?6 WHERE id=?1`)
            .bind(row.id, decision.handle, `https://www.instagram.com/${decision.handle}/`, now, note, Date.now()),
          env.DB.prepare('UPDATE ugc_creators SET normalized_handle=?2, updated_at=?3 WHERE id=?1 AND lower(normalized_handle)=?4')
            .bind(row.creator_id, decision.handle, Date.now(), old),
        ]);
        out.renamed++;
        out.results.push({ profile_id: row.id, old_handle: old, outcome: 'renamed', new_handle: decision.handle, evidence: decision.evidence });
      } else if (decision.outcome === 'alive') {
        await env.DB.prepare(`UPDATE ugc_creator_platforms SET availability_status='available', availability_checked_at=?2, availability_note=?3, rename_checked_at=?2 WHERE id=?1`)
          .bind(row.id, now, `${day}: аккаунт на месте — ${decision.evidence}`).run();
        out.alive++;
        out.results.push({ profile_id: row.id, old_handle: old, outcome: 'alive', evidence: decision.evidence });
      } else {
        await env.DB.prepare('UPDATE ugc_creator_platforms SET rename_checked_at=? WHERE id=?').bind(now, row.id).run();
        out.gone++;
        out.results.push({ profile_id: row.id, old_handle: old, outcome: 'gone', evidence: decision.evidence });
      }
    }
    return out;
  } finally {
    await env.DB.prepare('DELETE FROM erp_job_claims WHERE worker=? AND slot=?').bind(lock, lease).run().catch(() => undefined);
  }
}
