import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runLubertsyInvoices } from '../../_f4/lubertsy-invoices.mjs';

interface Env extends BaseEnv { DOCS: R2Bucket; }

export default erpWorker<Env>('erp-lubertsy-invoices', async (env, dry) => {
  if (dry) return { note: 'dry · no operations created' };
  const r = await runLubertsyInvoices(env);
  if (r?.errors?.length) throw new Error(`errors: ${r.errors.join(', ').slice(0, 400)}`);
  return {
    rows: (r?.opsCreated ?? 0) + (r?.opsLinked ?? 0) + (r?.paymentsMatched ?? 0),
    note: JSON.stringify({ ok: r.ok, opsCreated: r.opsCreated, opsLinked: r.opsLinked,
      paymentsMatched: r.paymentsMatched, review_required: r.review_required, skipped: r.skipped.length, skipExamples: r.skipped.slice(0, 3) }),
  };
});
