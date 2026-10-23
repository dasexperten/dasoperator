// Shared by the timer and the API: one terminal outcome, with atomic ownership.
export interface JournalRow {
  run_key: string;
  worker: string;
  api_owner: string | null;
  api_started_at: string | null;
  local_owner: string | null;
  local_started_at: string | null;
  finished_at: string | null;
  ok: number | null;
  rows: number | null;
  note: string | null;
  error: string | null;
}

export interface JournalOutcome { ok: boolean; rows?: number; note?: string; error?: string }
// A concurrent transport observed the same accepted slot. This is not a failed
// transport and must not overwrite the running owner's journal or diagnostics.
export class ApiStepPendingError extends Error {}
type Phase = (name: string) => void;

function transientD1(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (/Network connection lost|storage caused object to be reset|reset because its code was updated/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export async function journalWrite(write: () => Promise<D1Result>, retry: (attempt: number) => void): Promise<D1Result> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await write();
      const status = result as { success: boolean; error?: string };
      if (!status.success) throw new Error(status.error || 'D1 journal write unsuccessful');
      return result;
    } catch (error) {
      if (attempt >= 3 || !transientD1(error)) throw error;
      retry(attempt);
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25)));
    }
  }
}

export async function readRun(db: D1Database, runKey: string): Promise<JournalRow | null> {
  return db.prepare('SELECT run_key, worker, api_owner, api_started_at, local_owner, local_started_at, finished_at, ok, rows, note, error FROM erp_cron_runs WHERE run_key = ?')
    .bind(runKey).first<JournalRow>();
}

export function terminalOutcome(row: JournalRow): JournalOutcome {
  if (!row.finished_at || (row.ok !== 0 && row.ok !== 1)) throw new Error('Run has no confirmed terminal outcome');
  return { ok: row.ok === 1, ...(row.rows === null ? {} : { rows: row.rows }),
    ...(row.note === null ? {} : { note: row.note }), ...(row.error === null ? {} : { error: row.error }) };
}

export async function finishTimerRun(db: D1Database, runKey: string, outcome: JournalOutcome, phase: Phase, localOwner?: string)
  : Promise<{ state: 'finished'; outcome: JournalOutcome; apiOwned?: boolean; localOwned?: boolean } | { state: 'api_pending' } | { state: 'local_pending' }> {
  const finishedAt = new Date().toISOString();
  let result: D1Result;
  try { result = await journalWrite(() => db.prepare(`UPDATE erp_cron_runs
    SET finished_at = ?, ok = ?, rows = ?, note = ?, error = ?
    WHERE run_key = ? AND api_owner IS NULL AND finished_at IS NULL
      AND ${localOwner ? 'local_owner = ?' : 'local_owner IS NULL'}`)
    .bind(finishedAt, outcome.ok ? 1 : 0, outcome.rows ?? null, outcome.note?.slice(0, 1000) ?? null,
      outcome.error?.slice(0, 1000) ?? null, runKey, ...(localOwner ? [localOwner] : [])).run(), attempt => phase(`journal_finish_retry_${attempt}`));
  } catch (error) {
    const row = await readRun(db, runKey).catch(() => null);
    if (row?.finished_at) return { state: 'finished', outcome: terminalOutcome(row), ...(row.api_owner ? { apiOwned: true } : {}), ...(row.local_owner ? { localOwned: true } : {}) };
    throw error;
  }
  if (result.meta.changes === 1) return { state: 'finished', outcome, ...(localOwner ? { localOwned: true } : {}) };
  // Includes a lost acknowledgement of our own previous terminal write.
  const row = await readRun(db, runKey);
  if (!row) throw new Error('Run journal terminal update matched no unique row');
  if (row.finished_at) return { state: 'finished', outcome: terminalOutcome(row), ...(row.api_owner ? { apiOwned: true } : {}), ...(row.local_owner ? { localOwned: true } : {}) };
  if (row.local_owner) {
    if (row.local_owner === localOwner) throw new Error('Local run completion was not confirmed');
    return { state: 'local_pending' };
  }
  if (!row.api_owner) throw new Error('Run journal terminal update did not finish an unclaimed row');
  await journalWrite(() => db.prepare(`UPDATE erp_cron_runs SET transport_error = ?
    WHERE run_key = ? AND api_owner IS NOT NULL`)
    .bind(outcome.error?.slice(0, 1000) ?? 'API result not confirmed by caller', runKey).run(), attempt => phase(`journal_transport_retry_${attempt}`));
  // API may have finished while the diagnostic was written; its result wins.
  const latest = await readRun(db, runKey);
  if (latest?.finished_at) return { state: 'finished', outcome: terminalOutcome(latest), ...(latest.api_owner ? { apiOwned: true } : {}) };
  return { state: 'api_pending' };
}

/** Durable local ownership has no TTL: a disconnected caller never authorizes replay. */
export async function claimLocalRun(db: D1Database, worker: string, runKey: string, triggerSource: string, phase: Phase)
  : Promise<{ state: 'claimed'; owner: string } | { state: 'pending' } | { state: 'finished'; outcome: JournalOutcome }> {
  const owner = crypto.randomUUID(), startedAt = new Date().toISOString();
  phase('local_claim_start');
  let claimed: D1Result;
  try {
    claimed = await journalWrite(() => db.prepare(`UPDATE erp_cron_runs
      SET local_owner = ?, local_started_at = ?, local_trigger_source = ?
      WHERE run_key = ? AND worker = ? AND finished_at IS NULL AND api_owner IS NULL
        AND (local_owner IS NULL OR local_owner = ?)`)
      .bind(owner, startedAt, triggerSource, runKey, worker, owner).run(), attempt => phase(`local_claim_retry_${attempt}`));
  } catch (error) {
    const row = await readRun(db, runKey).catch(() => null);
    if (row?.worker !== worker || row.local_owner !== owner || row.finished_at) throw error;
    claimed = { success: true, meta: { changes: 1 } } as D1Result;
  }
  if (claimed.meta.changes === 1) return { state: 'claimed', owner };
  const row = await readRun(db, runKey);
  if (!row || row.worker !== worker) throw new Error('Local run journal row missing or worker mismatch');
  if (row.finished_at) return { state: 'finished', outcome: terminalOutcome(row) };
  if (row.local_owner || row.api_owner) return { state: 'pending' };
  throw new Error('Local run claim was not confirmed');
}

export async function runApiStep(db: D1Database, worker: string, runKey: string,
  job: () => Promise<string>, phase: Phase, triggerSource: string | null = null): Promise<JournalOutcome & { pending?: boolean }> {
  const owner = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  phase('erp_claim_start');
  // Retrying this statement after a lost acknowledgement is safe only for this
  // invocation's owner token. Other callers never reclaim an in-flight step.
  let claimed: D1Result;
  try { claimed = await journalWrite(() => db.prepare(`UPDATE erp_cron_runs SET api_owner = ?, api_started_at = ?, api_trigger_source = ?
    WHERE run_key = ? AND worker = ? AND finished_at IS NULL AND local_owner IS NULL AND (api_owner IS NULL OR api_owner = ?)`)
    .bind(owner, startedAt, triggerSource, runKey, worker, owner).run(), attempt => phase(`erp_claim_retry_${attempt}`));
  } catch (error) {
    const row = await readRun(db, runKey).catch(() => null);
    if (row?.worker !== worker || row.api_owner !== owner || row.finished_at) throw error;
    // This invocation has not run the job yet; its own durable claim is confirmation.
    claimed = { success: true, meta: { changes: 1 } } as D1Result;
  }
  if (claimed.meta.changes !== 1) {
    const row = await readRun(db, runKey);
    if (!row || row.worker !== worker) throw new Error('ERP run journal row missing or worker mismatch');
    if (row.finished_at) return terminalOutcome(row);
    if (row.api_owner || row.local_owner) return { ok: false, pending: true, error: 'ERP step already accepted; completion unconfirmed' };
    throw new Error('ERP run claim was not confirmed');
  }
  phase('erp_step_start');
  let outcome: JournalOutcome;
  try { outcome = { ok: true, note: await job() }; }
  catch (error) { outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  phase(outcome.ok ? 'erp_step_succeeded' : 'erp_step_failed');
  const finishedAt = new Date().toISOString();
  let finished: D1Result;
  try { finished = await journalWrite(() => db.prepare(`UPDATE erp_cron_runs
    SET finished_at = ?, ok = ?, rows = ?, note = ?, error = ?
    WHERE run_key = ? AND api_owner = ? AND finished_at IS NULL`)
    .bind(finishedAt, outcome.ok ? 1 : 0, outcome.rows ?? null, outcome.note?.slice(0, 1000) ?? null,
      outcome.error?.slice(0, 1000) ?? null, runKey, owner).run(), attempt => phase(`erp_finish_retry_${attempt}`));
  } catch (error) {
    const row = await readRun(db, runKey).catch(() => null);
    if (row?.finished_at) return terminalOutcome(row);
    throw error;
  }
  if (finished.meta.changes !== 1) {
    const row = await readRun(db, runKey);
    if (!row?.finished_at) throw new Error('ERP run completion was not confirmed');
    return terminalOutcome(row);
  }
  phase('erp_finish_persisted');
  return outcome;
}
