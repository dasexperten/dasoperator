// Runs each watched lane on the 3 / 15 / 30-minute rule (Owner 2026-10-15,
// DH-LAW-261015-01). The Worker ticks every minute; a lane runs only when due.
// State per lane in crm_sync_state under adaptive:<lane>.
import type { Env } from '../types';
import { afterCheck, laneDue } from './adaptive-cadence.mjs';

type LaneFn = (env: Env) => Promise<{ ok: boolean; activity: boolean; [k: string]: unknown }>;

export async function runAdaptiveLane(env: Env, lane: string, fn: LaneFn, now = Date.now(), probe?: (env: Env) => Promise<boolean>): Promise<string> {
  const key = `adaptive:${lane}`;
  const row = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(key).first<{ value: string }>();
  let state: any = null;
  try { state = row?.value ? JSON.parse(row.value) : null; } catch { state = null; }
  // Owner 2026-10-18: between scheduled checks a light probe may wake the lane at once (not during a running lease).
  if (!laneDue(state, now)) {
    const leased = Number.isFinite(state?.running_since) && now - state.running_since < 5 * 60_000;
    if (!probe || leased || !(await probe(env).catch(() => false))) return `${lane}: not due`;
  }
  // A run can last longer than a minute; the next tick must not start the same lane meanwhile
  // (Owner 2026-10-16: two answers to one blogger 2 s apart). Take a 5-minute lease atomically:
  // only the tick that still sees the old value moves next_at forward.
  const lease = JSON.stringify({ ...(state ?? {}), next_at: now + 5 * 60_000, running_since: now });
  const took = row?.value
    ? await env.DB.prepare(`UPDATE crm_sync_state SET value=?2, updated_at=?3 WHERE key=?1 AND value=?4`).bind(key, lease, now, row.value).run()
    : await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING`).bind(key, lease, now).run();
  if ((took.meta?.changes ?? 0) !== 1) return `${lane}: taken by another run`;
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
