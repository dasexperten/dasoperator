// Runs each watched lane on the 3 / 15 / 30-minute rule (Owner 2026-10-15,
// DH-LAW-261015-01). The Worker ticks every minute; a lane runs only when due.
// State per lane in crm_sync_state under adaptive:<lane>.
import type { Env } from '../types';
import { afterCheck, laneDue } from './adaptive-cadence.mjs';

type LaneFn = (env: Env) => Promise<{ ok: boolean; activity: boolean; [k: string]: unknown }>;

export async function runAdaptiveLane(env: Env, lane: string, fn: LaneFn, now = Date.now()): Promise<string> {
  const key = `adaptive:${lane}`;
  const row = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(key).first<{ value: string }>();
  let state: any = null;
  try { state = row?.value ? JSON.parse(row.value) : null; } catch { state = null; }
  if (!laneDue(state, now)) return `${lane}: not due`;
  let out: Awaited<ReturnType<LaneFn>>;
  try {
    out = await fn(env);
  } catch (e) {
    out = { ok: false, activity: false, error: e instanceof Error ? e.message : String(e) };
  }
  const next = afterCheck(state, out.ok && out.activity, now);
  await env.DB.prepare(
    `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, JSON.stringify(next), now).run();
  return `${lane}: ${JSON.stringify(out)} → next in ${next.delay_min} min`;
}
