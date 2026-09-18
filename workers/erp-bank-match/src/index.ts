import { erpWorker, type BaseEnv } from '../../_shared/run';
import { retryUnmatchedTransactions, rebalanceMisattributedMatches } from '../../../api/src/lib/bank-auto-match';
import type { Env as ErpEnv } from '../../../api/src/types';

export default erpWorker<BaseEnv>('erp-bank-match', async (env, dry) => {
  if (dry) return { note: 'dry · match skipped' };
  const erp = env as unknown as ErpEnv;
  const retry = await retryUnmatchedTransactions(erp);
  const rebalance = await rebalanceMisattributedMatches(erp);
  return {
    rows: retry.resolved + rebalance.rebalanced,
    note: `retry ${retry.resolved}/${retry.checked} resolved · rebalance ${rebalance.rebalanced}/${rebalance.scanned}`,
  };
});
