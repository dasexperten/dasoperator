import { journalWrite, finishTimerRun, readRun, terminalOutcome, ApiStepPendingError } from './run-journal';
import { hasStableSlot, hasScheduledDoor, slotRunKey, minuteSlot, currentHttpSlot, MINUTE_CRON, type TriggerSource } from './run-slot';

// Every erp-* worker is one action on one timer. This wrapper gives each of them the
// same run log (D1 erp_cron_runs), the same /health, and the same guarded manual /run.

export interface RunOutcome {
  rows?: number;
  note?: string;
}

export interface BaseEnv {
  DB: D1Database;
  DRY_RUN?: string;
  ERP_RUN_SECRET?: string;
}

export interface JobContext {
  runKey: string;
  scheduledTime?: number;
  triggerSource: TriggerSource;
  // Only fixed phase names; do not pass business payloads or upstream errors.
  phase: (name: string) => void;
}

type Job<E> = (env: E, dry: boolean, cron: string, context: JobContext) => Promise<RunOutcome>;

interface RunReport extends RunOutcome {
  ok: boolean;
  dry: boolean;
  error?: string;
  runKey?: string;
  jobOk?: boolean;
  journalError?: 'insert' | 'finish';
  apiPending?: boolean;
  apiOwned?: boolean;
}

export async function runLogged<E extends BaseEnv>(env: E, worker: string, cron: string, job: Job<E>, scheduledTime?: number,
  triggerSource: TriggerSource = scheduledTime === undefined ? 'manual' : 'cloudflare'): Promise<RunReport> {
  const dry = env.DRY_RUN === '1';
  const guarded = worker.startsWith('erp-wb-') && !dry;
  const lock = `lock:${worker}`;
  const now = Date.now();
  const stableSlot = hasStableSlot(worker, cron, scheduledTime);
  const runKey = stableSlot ? await slotRunKey(worker, cron, scheduledTime!) : crypto.randomUUID();
  const normalizedTime = scheduledTime === undefined ? null : minuteSlot(scheduledTime);
  const lease = crypto.randomUUID();
  let previousPhaseAt = now;
  const phase = (name: string) => {
    const at = Date.now();
    console.log(JSON.stringify({ worker, run_key: runKey, scheduledTime: scheduledTime ?? null, trigger_source: triggerSource, phase: name,
      elapsed_ms: at - now, phase_ms: at - previousPhaseAt }));
    previousPhaseAt = at;
  };
  const context: JobContext = { runKey, scheduledTime, triggerSource, phase };
  let lockHeld = false;
  let slotClaimed = false;
  let jobStarted = false;
  let terminalJournalFailed = false;
  const slotKey = `slot:${worker}:${scheduledTime}`;
  phase('start');
  try {
    if (stableSlot) {
      const existing = await readRun(env.DB, runKey);
      if (existing && existing.worker !== worker) throw new Error('Scheduled run worker mismatch');
      if (existing?.finished_at) {
        phase('slot_already_finished');
        return { ...terminalOutcome(existing), dry, runKey, ...(existing.api_owner ? { apiOwned: true } : {}) };
      }
      if (existing?.api_owner) {
        phase('slot_api_pending');
        return { ok: false, dry, runKey, apiPending: true, error: 'API accepted this slot; completion not yet confirmed' };
      }
      // Delayed CF deliveries must not catch up historical business work. A known
      // terminal result above may be returned, but an old unclaimed slot is inert.
      if (normalizedTime !== minuteSlot(Date.now())) {
        phase('slot_outside_current_minute');
        return { ok: true, dry, runKey, note: 'SKIPPED — scheduled slot is outside the current minute' };
      }
    }
    if (guarded) {
      const got = await env.DB.prepare(`INSERT INTO erp_job_claims (worker, slot, lease_until) VALUES (?, ?, ?)
        ON CONFLICT(worker) DO UPDATE SET slot=excluded.slot, lease_until=excluded.lease_until WHERE erp_job_claims.lease_until<=?
        RETURNING worker`).bind(lock, lease, now + 15 * 60_000, now).first();
      if (!got) { phase('lock_busy'); return { ok: true, dry, runKey, note: 'SKIPPED — WB sync already running' }; }
      lockHeld = true;
      if (scheduledTime !== undefined) {
        const slot = await env.DB.prepare(`INSERT OR IGNORE INTO erp_job_claims (worker, slot, lease_until) VALUES (?, ?, ?) RETURNING worker`)
          .bind(slotKey, String(scheduledTime), now).first();
        if (!slot) { phase('slot_consumed'); return { ok: true, dry, runKey, note: 'SKIPPED — scheduled WB slot already handled' }; }
        slotClaimed = true;
      }
    }
    const startedAt = new Date().toISOString();
    phase('journal_insert_start');
    try {
      await journalWrite(() => env.DB.prepare(
        'INSERT INTO erp_cron_runs (run_key, worker, cron, started_at, dry_run, scheduled_time, trigger_source) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_key) DO NOTHING',
      ).bind(runKey, worker, cron, startedAt, dry ? 1 : 0, normalizedTime, triggerSource).run(), attempt => phase(`journal_insert_retry_${attempt}`));
    } catch (error) {
      phase('journal_insert_failed');
      return { ok: false, dry, runKey, journalError: 'insert', error: `Run journal insert failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    phase('journal_insert_finished');

    let report: RunReport;
    jobStarted = true;
    phase('job_start');
    try {
      const out = await job(env, dry, cron, context);
      report = { ...out, ok: true, dry, runKey };
    } catch (error) {
      if (error instanceof ApiStepPendingError) {
        phase('slot_api_pending');
        return { ok: false, dry, runKey, apiPending: true, error: 'API accepted this slot; completion not yet confirmed' };
      }
      report = { ok: false, dry, runKey, error: error instanceof Error ? error.message : String(error) };
    }
    phase(report.ok ? 'job_succeeded' : 'job_failed');
    phase('journal_finish_start');
    try {
      const final = await finishTimerRun(env.DB, runKey, report, phase);
      if (final.state === 'api_pending') {
        terminalJournalFailed = true;
        phase('api_completion_pending');
        return { ok: false, dry, runKey, apiPending: true, error: 'API accepted this run; completion not yet confirmed' };
      }
      report = { ...final.outcome, dry, runKey, ...(final.apiOwned ? { apiOwned: true } : {}) };
    } catch (error) {
      terminalJournalFailed = true;
      phase('journal_finish_failed');
      return { ...report, ok: false, jobOk: report.ok, journalError: 'finish',
        error: `Run journal finish failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    phase('journal_finish_finished');
    return report;
  } finally {
    // A slot is consumed only after the action starts. Preserve consumed slots even
    // when final logging fails, and always attempt to release this invocation's lock.
    try {
      if (slotClaimed && !jobStarted) await env.DB.prepare('DELETE FROM erp_job_claims WHERE worker=? AND slot=?')
        .bind(slotKey, String(scheduledTime)).run();
    } finally {
      if (lockHeld) {
        try {
          await env.DB.prepare('DELETE FROM erp_job_claims WHERE worker=? AND slot=?').bind(lock, lease).run();
        } catch (error) {
          phase('lock_release_failed');
          // Preserve the terminal-journal report so scheduled noRetry still runs.
          // The existing lock lease expires; do not turn this into action replay.
          if (!terminalJournalFailed) throw error;
        }
      }
      phase('end');
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function erpWorker<E extends BaseEnv>(worker: string, job: Job<E>): ExportedHandler<E> {
  return {
    async scheduled(event, env, ctx) {
      ctx.waitUntil(
        runLogged(env, worker, event.cron, job, event.scheduledTime).then((r) => {
          if (!r.ok) {
            if (r.journalError === 'finish' || r.apiPending || r.apiOwned) {
              // An accepted API job may have completed some independent effects before
              // failing. Its next natural cron owns recovery; do not replay the whole job.
              if (typeof event.noRetry === 'function') event.noRetry();
              else {
                console.error(JSON.stringify({ worker, run_key: r.runKey, scheduledTime: event.scheduledTime,
                  phase: r.apiPending ? 'api_pending_no_retry_unavailable' : 'journal_finish_failed_no_retry_unavailable', ok: false, jobOk: r.jobOk }));
                return;
              }
            }
            throw new Error(r.error);
          }
        }),
      );
    },

    async fetch(req, env) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        // Report journal availability separately from the latest action's state.
        let last_run = null;
        try {
          last_run = await env.DB.prepare(
            'SELECT run_key, cron, scheduled_time, trigger_source, api_trigger_source, started_at, finished_at, api_started_at, transport_error, ok, rows, error FROM erp_cron_runs WHERE worker = ? ORDER BY id DESC LIMIT 1',
          ).bind(worker).first<{ finished_at: string | null; ok: number | null; transport_error?: string | null }>();
        } catch {
          return Response.json({ ok: false, worker, dry_run: env.DRY_RUN === '1', last_run: null,
            last_run_status: 'unavailable', error: 'Run journal unavailable' }, { status: 503 });
        }
        const last_run_status = !last_run ? 'none' : !last_run.finished_at ? (last_run.transport_error ? 'completion_unconfirmed' : 'running') : last_run.ok === 1 ? 'succeeded' : 'failed';
        return Response.json({ ok: true, worker, dry_run: env.DRY_RUN === '1', last_run, last_run_status });
      }
      if (url.pathname === '/run' && req.method === 'POST') {
        const secret = env.ERP_RUN_SECRET ?? '';
        const given = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        if (!secret || !sameSecret(given, secret)) return new Response('unauthorized', { status: 401 });
        return Response.json(await runLogged(env, worker, 'manual', job));
      }
      if (url.pathname === '/scheduled' && req.method === 'POST') {
        const secret = env.ERP_RUN_SECRET ?? '';
        const given = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        if (!secret || !sameSecret(given, secret)) return new Response('unauthorized', { status: 401 });
        if (!hasScheduledDoor(worker)) return Response.json({ ok: false, error: 'Scheduled HTTP transport is not enabled for this worker' }, { status: 404 });
        const scheduledTime = currentHttpSlot(await req.json().catch(() => null), Date.now());
        if (scheduledTime === null) return Response.json({ ok: false, error: 'Expected the current UTC minute scheduledTime' }, { status: 400 });
        const report = await runLogged(env, worker, MINUTE_CRON, job, scheduledTime, 'external_clock');
        return Response.json({ ...report, scheduledTime, triggerSource: 'external_clock' },
          { status: report.apiPending ? 409 : report.ok ? 200 : 503 });
      }
      return new Response('not found', { status: 404 });
    },
  };
}
