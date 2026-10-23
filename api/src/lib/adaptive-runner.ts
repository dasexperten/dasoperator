// Runs each watched lane on the 3 / 15 / 30-minute rule (Owner 2026-10-15,
// DH-LAW-261015-01). The Worker ticks every minute; a lane runs only when due.
// State per lane in crm_sync_state under adaptive:<lane>.
import type { Env } from '../types';
import { afterCheck, laneDue } from './adaptive-cadence.mjs';

type LaneFn = (env: Env) => Promise<{ ok: boolean; activity: boolean; [k: string]: unknown }>;
const LEASE_MS = 5 * 60_000;

function leaseActive(state: any, now: number): boolean {
  if (!Number.isFinite(state?.running_since)) return false;
  // During rollout, an older Direct run may still renew next_at only.
  const until = Number.isFinite(state.lease_until) ? state.lease_until
    : Math.max(state.running_since + LEASE_MS, Number(state.next_at) || 0);
  return now < until;
}

export async function runAdaptiveLane(env: Env, lane: string, fn: LaneFn, now = Date.now(), probe?: (env: Env) => Promise<boolean>): Promise<string> {
  const key = `adaptive:${lane}`;
  const row = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(key).first<{ value: string }>();
  let state: any = null;
  try { state = row?.value ? JSON.parse(row.value) : null; } catch { state = null; }
  // A live lease wins over cadence and the new-message probe, including when
  // the original start is older than five minutes but its heartbeat is fresh.
  if (leaseActive(state, now)) return `${lane}: not due (running)`;
  // Owner 2026-10-18: between scheduled checks a light probe may wake the lane at once (not during a running lease).
  if (!laneDue(state, now)) {
    if (!probe || !(await probe(env).catch(() => false))) return `${lane}: not due`;
  }
  // A run can last longer than a minute; the next tick must not start the same lane meanwhile
  // (Owner 2026-10-16: two answers to one blogger 2 s apart). Take a 5-minute lease atomically:
  // only the tick that still sees the old value moves next_at forward.
  const token = crypto.randomUUID();
  const lease = JSON.stringify({ ...(state ?? {}), next_at: now + LEASE_MS, running_since: now, lease_until: now + LEASE_MS, lease_token: token });
  const took = row?.value
    ? await env.DB.prepare(`UPDATE crm_sync_state SET value=?2, updated_at=?3 WHERE key=?1 AND value=?4`).bind(key, lease, now, row.value).run()
    : await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING`).bind(key, lease, now).run();
  if ((took.meta?.changes ?? 0) !== 1) return `${lane}: taken by another run`;
  // Renew during the entire lane, not only while the reply writer is running.
  // Both renewal and completion belong to this token; a delayed old operation
  // cannot extend or replace the next owner's lease.
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    const touched = Date.now();
    try {
      await env.DB.prepare(`UPDATE crm_sync_state SET value=json_set(value,'$.lease_until',?2,'$.next_at',?2),updated_at=?3
        WHERE key=?1 AND json_extract(value,'$.lease_token')=?4`)
        .bind(key, touched + LEASE_MS, touched, token).run();
    } catch { /* the lease expires if storage is unavailable; completion still checks ownership */ }
    finally { renewing = false; }
  }, 60_000);
  try {
    let out: Awaited<ReturnType<LaneFn>>;
    try {
      out = await fn(env);
    } catch (e) {
      out = { ok: false, activity: false, error: e instanceof Error ? e.message : String(e) };
    }
    const completedAt = Math.max(now, Date.now());
    const next = {
      ...afterCheck(state, out.ok && out.activity, completedAt),
      last_started_at: now,
      last_finished_at: completedAt,
      last_duration_ms: completedAt - now,
      last_ok: out.ok,
    };
    // Owner 2026-10-21: a lane that failed is not idle — it is retried in 3 minutes, never parked at 30.
    if (!out.ok) { next.next_at = completedAt + 3 * 60_000; next.delay_min = 3; }
    const saved = await env.DB.prepare(
      `UPDATE crm_sync_state SET value=?2, updated_at=?3
       WHERE key=?1 AND json_extract(value,'$.lease_token')=?4`
    ).bind(key, JSON.stringify(next), completedAt, token).run();
    const line = `${lane}: ${JSON.stringify(out)} → next in ${next.delay_min} min`;
    // Owner 2026-10-21: a failed lane is a failed run in the journal, so Mina hears of it (it used to be recorded as success).
    if (!out.ok) throw new Error(line);
    if ((saved.meta?.changes ?? 0) !== 1) return `${lane}: lease no longer owned; result not scheduled`;
    return line;
  } finally { clearInterval(heartbeat); }
}
