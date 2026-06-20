// =============================================================================
// email-retention.ts — monthly compaction of the Emailer hot layer.
//
// D1 is the HOT working store; it must not grow without bound. This rolls the
// churny, already-resolved operational rows out to cheap R2 cold storage as
// JSONL, then deletes them from D1. It is fully reversible — every archived row
// is written to R2 before it is removed, so it can be re-imported if ever needed.
//
// NEVER TOUCHED (the permanent "canon" / config — small and high-value):
//   email_playbook, email_rules, email_scenarios, email_settings
//
// Cold criteria (older than retention_days, default 90; configurable via the
// email_settings key `retention_days`):
//   email_agent_tasks     — status='sent' and sent/created before cutoff
//   email_classifications — created before cutoff (cheap, re-derivable cache)
//   email_lessons         — already decided (approved/rejected) before cutoff
//                           (the knowledge already lives in email_playbook)
//   invoice_inbox         — only soft-deleted rows (deleted_at set) before cutoff
//                           (live financial records are left untouched)
// =============================================================================

import type { Env } from '../types';

export interface RetentionStats {
  cutoff_days: number;
  month: string;
  archived: Record<string, number>;
  r2_keys: string[];
  errors: string[];
}

const ARCHIVE_PREFIX = 'archive/email';
const CAP_PER_TABLE = 5000;   // bounded per run; monthly cadence + re-run covers backlog
const DELETE_CHUNK = 100;

interface Spec {
  name: string;
  idCol: string;
  sql: string;
}

export async function runEmailRetention(env: Env): Promise<RetentionStats> {
  const now = Math.floor(Date.now() / 1000);

  let days = 90;
  try {
    const row = await env.DB.prepare("SELECT value FROM email_settings WHERE key = 'retention_days'").first<{ value: string }>();
    const n = row ? parseInt(row.value, 10) : NaN;
    if (Number.isFinite(n) && n >= 7) days = n;
  } catch { /* keep default */ }

  const cutoff = now - days * 86400;
  const month = new Date(now * 1000).toISOString().slice(0, 7); // YYYY-MM
  const stats: RetentionStats = { cutoff_days: days, month, archived: {}, r2_keys: [], errors: [] };

  const specs: Spec[] = [
    { name: 'email_agent_tasks', idCol: 'id', sql: `SELECT * FROM email_agent_tasks WHERE status = 'sent' AND COALESCE(sent_at, created_at) < ? LIMIT ${CAP_PER_TABLE}` },
    { name: 'email_classifications', idCol: 'thread_id', sql: `SELECT * FROM email_classifications WHERE created_at < ? LIMIT ${CAP_PER_TABLE}` },
    { name: 'email_lessons', idCol: 'id', sql: `SELECT * FROM email_lessons WHERE status IN ('approved','rejected') AND COALESCE(decided_at, created_at) < ? LIMIT ${CAP_PER_TABLE}` },
    { name: 'invoice_inbox', idCol: 'id', sql: `SELECT * FROM invoice_inbox WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ${CAP_PER_TABLE}` },
  ];

  for (const spec of specs) {
    try {
      const res = await env.DB.prepare(spec.sql).bind(cutoff).all<Record<string, unknown>>();
      const rows = res.results || [];
      if (!rows.length) { stats.archived[spec.name] = 0; continue; }

      // 1) write to R2 first (unique key per run so nothing is ever overwritten)
      const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const key = `${ARCHIVE_PREFIX}/${month}/${spec.name}-${now}.jsonl`;
      await env.ARCHIVE.put(key, jsonl, { httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' } });
      stats.r2_keys.push(key);

      // 2) only after the archive write succeeds, delete from D1
      const ids = rows.map((r) => r[spec.idCol]).filter((v) => v !== null && v !== undefined);
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const slice = ids.slice(i, i + DELETE_CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        await env.DB.prepare(`DELETE FROM ${spec.name} WHERE ${spec.idCol} IN (${placeholders})`).bind(...slice).run();
      }
      stats.archived[spec.name] = ids.length;
    } catch (e) {
      stats.errors.push(`${spec.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return stats;
}
