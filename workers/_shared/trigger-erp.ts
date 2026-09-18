// An erp-* worker whose job still runs inside dasoperator-api on the ERP's own keys:
// the worker owns the timer and the run log, and starts the job through /internal/cron.
import { erpWorker, type BaseEnv } from './run';

export interface TriggerEnv extends BaseEnv {
  ERP: Fetcher;
}

export function erpTriggerWorker(worker: string): ExportedHandler<TriggerEnv> {
  return erpWorker<TriggerEnv>(worker, async (env, dry) => {
    if (dry) return { note: 'dry · ERP job not started' };
    // A fresh deploy runs before its key is set: record the skip instead of alerting.
    if (!env.ERP_RUN_SECRET) return { note: 'SKIPPED — no ERP_RUN_SECRET on this worker yet' };
    const res = await env.ERP.fetch(`https://internal/internal/cron/${worker}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ERP_RUN_SECRET ?? ''}` },
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; cron?: string; ms?: number; note?: string; error?: string } | null;
    if (!res.ok || !body?.ok) throw new Error(`ERP job ${worker}: HTTP ${res.status} ${body?.error ?? ''}`.trim());
    return { note: body.note ? `${body.note} · ${body.ms} ms` : `ERP job "${body.cron}" done in ${body.ms} ms` };
  });
}
