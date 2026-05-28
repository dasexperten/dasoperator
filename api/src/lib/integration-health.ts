// =============================================================================
// Integration health detector — proactive watchdog, Layer 1 ("detect").
//
//   healthy   — reported success within its SLA
//   degraded  — late / rate-limited (429) but self-recovering; no human, no action
//   broken    — silent past SLA, or an unhealed failure; needs a human
//
// Read-only. SLAs match each API's REAL cadence (WB stocks sync ~every 4h by
// design due to its rate limit — a 1h SLA would false-alarm constantly).
// =============================================================================

import type { Env } from '../types';

export type HealthStatus = 'healthy' | 'degraded' | 'broken';

export interface IntegrationHealth {
  key: string;
  label: string;
  status: HealthStatus;
  last_success_at: number | null;
  age_minutes: number | null;
  detail: string;
  expects: string;
  ok_24h: number;
  err_24h: number;
}

export interface HealthReport {
  checked_at: number;
  overall: HealthStatus;
  needs_you: number;
  integrations: IntegrationHealth[];
}

const HOUR = 3600;

interface MpRule {
  key: string;
  label: string;
  log_name: string;
  expects: string;
  degraded_after_h: number;
  broken_after_h: number;
}

const MP_RULES: MpRule[] = [
  { key: 'ozon_stocks', label: 'Ozon \u00b7 stocks', log_name: 'ozon',       expects: 'every 1h',          degraded_after_h: 2, broken_after_h: 4 },
  { key: 'ozon_sales',  label: 'Ozon \u00b7 sales',  log_name: 'ozon-sales', expects: 'every 1h (429 ok)', degraded_after_h: 4, broken_after_h: 12 },
  { key: 'wb_stocks',   label: 'WB \u00b7 stocks',   log_name: 'wb',         expects: 'every ~4h (WB limit)', degraded_after_h: 6, broken_after_h: 10 },
  { key: 'wb_sales',    label: 'WB \u00b7 sales',    log_name: 'wb-sales',   expects: 'every 1h (429 ok)', degraded_after_h: 6, broken_after_h: 24 },
];

function classifyAge(ageH: number | null, degradedAfterH: number, brokenAfterH: number): HealthStatus {
  if (ageH === null) return 'broken';
  if (ageH <= degradedAfterH) return 'healthy';
  if (ageH <= brokenAfterH) return 'degraded';
  return 'broken';
}

function fmtAgo(min: number | null): string {
  if (min === null) return 'never';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function trimErr(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 77) + '\u2026' : t;
}

async function checkMarketplace(env: Env, now: number, r: MpRule): Promise<IntegrationHealth> {
  const dayAgo = now - 86400;
  const [lastOk, lastAttempt, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT MAX(finished_at) AS t FROM marketplace_sync_log WHERE marketplace = ? AND status = 'ok'`
    ).bind(r.log_name).first<{ t: number | null }>(),
    env.DB.prepare(
      `SELECT status, error_message FROM marketplace_sync_log WHERE marketplace = ? ORDER BY started_at DESC LIMIT 1`
    ).bind(r.log_name).first<{ status: string; error_message: string | null }>(),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM marketplace_sync_log WHERE marketplace = ? AND started_at > ? GROUP BY status`
    ).bind(r.log_name, dayAgo).all<{ status: string; c: number }>(),
  ]);

  const lastOkAt = lastOk?.t ?? null;
  const ageMin = lastOkAt ? Math.round((now - lastOkAt) / 60) : null;
  const ageH = lastOkAt ? (now - lastOkAt) / HOUR : null;
  const status = classifyAge(ageH, r.degraded_after_h, r.broken_after_h);

  let ok24 = 0;
  let err24 = 0;
  for (const row of counts?.results ?? []) {
    if (row.status === 'ok') ok24 = row.c;
    else err24 += row.c;
  }

  let detail: string;
  if (status === 'healthy') {
    detail = lastOkAt ? `last success ${fmtAgo(ageMin)} \u00b7 ${ok24}/${ok24 + err24} ok in 24h` : 'no runs yet';
  } else if (status === 'degraded') {
    const why = lastAttempt?.error_message ? trimErr(lastAttempt.error_message) : 'late';
    detail = `${why} \u00b7 retrying \u00b7 last success ${fmtAgo(ageMin)}`;
  } else {
    detail = lastOkAt ? `no success for ${fmtAgo(ageMin)} \u2014 needs you` : 'never reported success \u2014 needs you';
  }

  return { key: r.key, label: r.label, status, last_success_at: lastOkAt, age_minutes: ageMin, detail, expects: r.expects, ok_24h: ok24, err_24h: err24 };
}

// A backfill task that still advances pages under WB's rate limit is HEALTHY,
// just slow. Only a task that became ELIGIBLE (next_attempt_at <= now) more
// than 6h ago yet was never picked up by the tick is genuinely frozen.
async function checkWbBackfill(env: Env, now: number): Promise<IntegrationHealth> {
  const frozenCutoff = now - 6 * HOUR;
  const [counts, frozen] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM marketplace_pull_tasks WHERE marketplace = 'wb' GROUP BY status`
    ).all<{ status: string; c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM marketplace_pull_tasks WHERE marketplace = 'wb' AND status = 'fetching' AND next_attempt_at <= ?`
    ).bind(frozenCutoff).first<{ c: number }>(),
  ]);

  let fetching = 0;
  let done = 0;
  for (const row of counts?.results ?? []) {
    if (row.status === 'fetching') fetching = row.c;
    if (row.status === 'done') done = row.c;
  }
  const frozenN = frozen?.c ?? 0;

  let status: HealthStatus = 'healthy';
  let detail: string;
  if (frozenN > 0) {
    status = 'degraded';
    detail = `${frozenN} task(s) frozen >6h \u2014 will nudge`;
  } else if (fetching > 0) {
    detail = `${fetching} draining (rate-limited, progressing)`;
  } else {
    detail = `all ${done} tasks done`;
  }
  return { key: 'wb_backfill', label: 'WB \u00b7 backfill tasks', status, last_success_at: null, age_minutes: null, detail, expects: 'drains every 15 min', ok_24h: done, err_24h: frozenN };
}

async function checkModulbank(env: Env, now: number): Promise<IntegrationHealth> {
  const since = now - 26 * HOUR;
  const [lastFail, lastHeal, lastTx] = await Promise.all([
    env.DB.prepare(
      `SELECT occurred_at, error_message FROM sync_failures WHERE service_name LIKE 'modulbank%' ORDER BY occurred_at DESC LIMIT 1`
    ).first<{ occurred_at: number; error_message: string | null }>(),
    env.DB.prepare(
      `SELECT occurred_at, result FROM auto_heal_log WHERE service_name LIKE 'modulbank%' ORDER BY occurred_at DESC LIMIT 1`
    ).first<{ occurred_at: number; result: string }>(),
    env.DB.prepare(
      `SELECT MAX(created_at) AS t FROM bank_transactions`
    ).first<{ t: number | null }>(),
  ]);

  const lastTxAt = lastTx?.t ?? null;
  const txAgeMin = lastTxAt ? Math.round((now - lastTxAt) / 60) : null;

  const unhealedRecentFailure = Boolean(
    lastFail &&
    lastFail.occurred_at >= since &&
    !(lastHeal && lastHeal.result === 'success' && lastHeal.occurred_at >= lastFail.occurred_at)
  );

  let status: HealthStatus = 'healthy';
  let detail: string;
  if (unhealedRecentFailure) {
    status = 'broken';
    detail = `${trimErr(lastFail!.error_message || 'sync error')} \u2014 needs you`;
  } else {
    detail = lastTxAt ? `last transaction ${fmtAgo(txAgeMin)} \u00b7 self-healing on` : 'no transactions yet';
  }

  const err24 = lastFail && lastFail.occurred_at >= now - 86400 ? 1 : 0;
  return { key: 'modulbank', label: 'Modulbank', status, last_success_at: lastTxAt, age_minutes: txAgeMin, detail, expects: 'every 1h \u00b7 alert if silent >26h', ok_24h: 0, err_24h: err24 };
}

export async function computeIntegrationHealth(env: Env): Promise<HealthReport> {
  const now = Math.floor(Date.now() / 1000);
  const checks = await Promise.all([
    ...MP_RULES.map((r) => checkMarketplace(env, now, r)),
    checkWbBackfill(env, now),
    checkModulbank(env, now),
  ]);

  const order = ['ozon_stocks', 'ozon_sales', 'wb_stocks', 'wb_sales', 'wb_backfill', 'modulbank'];
  checks.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  const needsYou = checks.filter((c) => c.status === 'broken').length;
  const overall: HealthStatus = needsYou > 0 ? 'broken' : checks.some((c) => c.status === 'degraded') ? 'degraded' : 'healthy';

  return { checked_at: now, overall, needs_you: needsYou, integrations: checks };
}
