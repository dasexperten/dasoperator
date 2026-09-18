import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runLubertsyInvoices } from '../../_f4/lubertsy-invoices.mjs';

export default erpWorker<BaseEnv>('erp-lubertsy-invoices', async (env, dry) => {
  if (dry) return { note: 'dry · no operations created' };
  const r = await runLubertsyInvoices(env);
  if (r?.errors?.length) throw new Error(`errors: ${r.errors.join(', ').slice(0, 400)}`);
  return { rows: (r?.opsCreated ?? 0) + (r?.opsLinked ?? 0) + (r?.paymentsMatched ?? 0), note: JSON.stringify(r).slice(0, 600) };
});
