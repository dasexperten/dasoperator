// =============================================================================
// Watchdog — proactive act layer (mode B).
//
//   1. SAFE FIX  — nudge genuinely-frozen WB backfill tasks (eligible >6h,
//                  never picked by the tick). Slow-but-progressing tasks are
//                  left alone; nudging a throttled task only causes more 429.
//   2. ESCALATE  — any 'broken' integration is reported once per 3h via the
//                  existing auto-healer (logs sync_failures + Telegram ping).
//   3. RECORD    — every scan writes a heartbeat row to auto_heal_log so the
//                  health page can show "last checked / fixes in 24h".
//
// 429 / late = self-recovering. Watchdog records it but never acts on it.
// =============================================================================

import type { Env } from '../types';
import { computeIntegrationHealth } from './integration-health';
import { reportCronFailure } from './auto-healer';

const HOUR = 3600;
const nowTs = (): number => Math.floor(Date.now() / 1000);

export interface WatchdogResult {
  checked_at: number;
  overall: string;
  needs_you: number;
  actions: string[];
}

async function logScan(
  env: Env,
  service: string,
  action: string,
  result: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auto_heal_log
       (id, recipe_id, service_name, triggered_by_error, action_taken, result, details, occurred_at, duration_ms)
     VALUES (?, NULL, ?, '', ?, ?, ?, ?, 0)`
  ).bind(
    `heal_${crypto.randomUUID()}`,
    service,
    action,
    result,
    JSON.stringify(details ?? null),
    nowTs(),
  ).run();
}

export async function runWatchdog(env: Env): Promise<WatchdogResult> {
  const ts = nowTs();
  const report = await computeIntegrationHealth(env);
  const actions: string[] = [];

  // 1) SAFE FIX — nudge frozen backfill tasks (eligible >6h, never picked)
  const frozenCutoff = ts - 6 * HOUR;
  const frozen = await env.DB.prepare(
    `SELECT id FROM marketplace_pull_tasks
     WHERE marketplace = 'wb' AND status = 'fetching' AND next_attempt_at <= ?`
  ).bind(frozenCutoff).all<{ id: string }>();
  const frozenIds = (frozen.results || []).map((r) => r.id);
  if (frozenIds.length > 0) {
    await env.DB.prepare(
      `UPDATE marketplace_pull_tasks
       SET next_attempt_at = ?, last_error = 'nudged by watchdog (frozen >6h)'
       WHERE marketplace = 'wb' AND status = 'fetching' AND next_attempt_at <= ?`
    ).bind(ts, frozenCutoff).run();
    await logScan(env, 'wb_backfill', 'requeue_frozen', 'success', { ids: frozenIds });
    actions.push(`re-queued ${frozenIds.length} frozen backfill task(s)`);
  }

  // 2) ESCALATE — broken integrations, deduped to once per 3h
  for (const it of report.integrations) {
    if (it.status !== 'broken') continue;
    const svc = `watchdog:${it.key}`;
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM sync_failures WHERE service_name = ? AND occurred_at >= ?`
    ).bind(svc, ts - 3 * HOUR).first<{ c: number }>();
    if ((recent?.c ?? 0) === 0) {
      await reportCronFailure(env, svc, new Error(`${it.label}: ${it.detail}`), { cron: 'watchdog' });
      actions.push(`escalated ${it.label}`);
    }
  }

  // 3) RECORD scan heartbeat
  await logScan(env, 'watchdog', 'scan', 'success', {
    overall: report.overall,
    needs_you: report.needs_you,
    actions,
  });

  return { checked_at: report.checked_at, overall: report.overall, needs_you: report.needs_you, actions };
}
