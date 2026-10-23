import { journalWrite, finishTimerRun, readRun, terminalOutcome, claimLocalRun, ApiStepPendingError } from './run-journal';
import { hasStableSlot, hasScheduledDoor, isLocalScheduledWorker, slotRunKey, minuteSlot, currentHttpSchedule, dueScheduledSlot, matchesScheduledCron, type TriggerSource } from './run-slot';

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
  localPending?: boolean;
  localOwned?: boolean;
}

export async function runLogged<E extends BaseEnv>(env: E, worker: string, cron: string, job: Job<E>, scheduledTime?: number,
  triggerSource: TriggerSource = scheduledTime === undefined ? 'manual' : 'cloudflare'): Promise<RunReport> {
  const dry = env.DRY_RUN === '1';
  const guarded = worker.startsWith('erp-wb-') && !dry;
  const lock = `lock:${worker}`;
  const now = Date.now();
  const stableSlot = hasStableSlot(worker, cron, scheduledTime);
  const localExecution = isLocalScheduledWorker(worker);
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
  let calendarSkip: string | undefined;
  let localOwner: string | undefined;
  const slotKey = `slot:${worker}:${scheduledTime}`;
  phase('start');
  try {
    if (stableSlot) {
      if (!matchesScheduledCron(worker, cron, scheduledTime!)) {
        phase('slot_not_scheduled');
        return { ok: true, dry, runKey, note: 'SKIPPED — slot does not match the configured schedule' };
      }
      const existing = await readRun(env.DB, runKey);
      if (existing && existing.worker !== worker) throw new Error('Scheduled run worker mismatch');
      if (existing?.finished_at) {
        phase('slot_already_finished');
        return { ...terminalOutcome(existing), dry, runKey, ...(existing.api_owner ? { apiOwned: true } : {}), ...(existing.local_owner ? { localOwned: true } : {}) };
      }
      if (existing?.api_owner) {
        phase('slot_api_pending');
        return { ok: false, dry, runKey, apiPending: true, error: 'API accepted this slot; completion not yet confirmed' };
      }
      if (existing?.local_owner) {
        phase('slot_local_pending');
        return { ok: false, dry, runKey, localPending: true, error: 'Local job accepted this slot; completion not yet confirmed' };
      }
      // Delayed CF deliveries must not catch up historical business work. A known
      // terminal result above may be returned, but an old unclaimed slot is inert.
      if (normalizedTime !== minuteSlot(Date.now())) {
        phase('slot_outside_current_minute');
        return { ok: true, dry, runKey, note: 'SKIPPED — scheduled slot is outside the current minute' };
      }
      if (!dueScheduledSlot(worker, cron, scheduledTime!)) {
        // The weekly wakeup still has an honest skip journal on other Wednesdays;
        // no ERP action runs and it must not be counted as an actual recovery.
        calendarSkip = 'site_sales_rebuild: not due (SKIPPED — first Wednesday only)';
      }
      if (localExecution) {
        // During rollout an older wrapper may still own work under a random key.
        // The new slot key cannot dedupe that invocation. Wait out the existing
        // scheduled execution budget without clearing or falsely closing its row.
        const legacy = await env.DB.prepare(`SELECT run_key FROM erp_cron_runs
          WHERE worker = ? AND COALESCE(run_key, '') <> ? AND finished_at IS NULL
            AND api_owner IS NULL AND local_owner IS NULL AND started_at >= ? LIMIT 1`)
          .bind(worker, runKey, new Date(Date.now() - 15 * 60_000).toISOString()).first();
        if (legacy) {
          phase('legacy_local_run_pending');
          return { ok: false, dry, runKey, localPending: true, error: 'Legacy local invocation is still within its execution window' };
        }
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

    if (localExecution && !calendarSkip) {
      const claim = await claimLocalRun(env.DB, worker, runKey, triggerSource, phase);
      if (claim.state === 'finished') return { ...claim.outcome, dry, runKey, localOwned: true };
      if (claim.state === 'pending') return { ok: false, dry, runKey, localPending: true, error: 'Local job accepted this slot; completion not yet confirmed' };
      localOwner = claim.owner;
      phase('local_claim_finished');
    }

    let report: RunReport;
    jobStarted = true;
    phase('job_start');
    try {
      const out = calendarSkip ? { note: calendarSkip } : await job(env, dry, cron, context);
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
      const final = await finishTimerRun(env.DB, runKey, report, phase, localOwner);
      if (final.state === 'api_pending') {
        terminalJournalFailed = true;
        phase('api_completion_pending');
        return { ok: false, dry, runKey, apiPending: true, error: 'API accepted this run; completion not yet confirmed' };
      }
      if (final.state === 'local_pending') {
        terminalJournalFailed = true;
        return { ok: false, dry, runKey, localPending: true, error: 'Local run completion not confirmed by its owner' };
      }
      report = { ...final.outcome, dry, runKey, ...(final.apiOwned ? { apiOwned: true } : {}), ...(final.localOwned ? { localOwned: true } : {}) };
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
            if (r.journalError === 'finish' || r.apiPending || r.apiOwned || r.localPending || r.localOwned) {
              // An accepted API job may have completed some independent effects before
              // failing. Its next natural cron owns recovery; do not replay the whole job.
              if (typeof event.noRetry === 'function') event.noRetry();
              else {
                console.error(JSON.stringify({ worker, run_key: r.runKey, scheduledTime: event.scheduledTime,
                  phase: r.apiPending ? 'api_pending_no_retry_unavailable' : r.localPending ? 'local_pending_no_retry_unavailable' : 'journal_finish_failed_no_retry_unavailable', ok: false, jobOk: r.jobOk }));
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
            'SELECT run_key, cron, scheduled_time, trigger_source, api_trigger_source, local_trigger_source, started_at, finished_at, api_started_at, local_started_at, transport_error, ok, rows, error FROM erp_cron_runs WHERE worker = ? ORDER BY id DESC LIMIT 1',
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
        const schedule = currentHttpSchedule(worker, await req.json().catch(() => null), Date.now());
        if (schedule === null) return Response.json({ ok: false, error: 'Expected a configured cron due in the current UTC minute' }, { status: 400 });
        const report = await runLogged(env, worker, schedule.cron, job, schedule.scheduledTime, 'external_clock');
        return Response.json({ ...report, ...schedule, triggerSource: 'external_clock' },
          { status: report.apiPending || report.localPending ? 409 : report.ok ? 200 : 503 });
      }
      return new Response('not found', { status: 404 });
    },
  };
}
