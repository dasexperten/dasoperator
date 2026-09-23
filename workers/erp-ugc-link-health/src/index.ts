import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runUgcLinkHealthBatch } from '../../../api/src/lib/ugc-link-health';

export default erpWorker<BaseEnv>('erp-ugc-link-health', async (env, dry) => {
  if (dry) return { note: 'dry · UGC links not fetched' };
  return { note: JSON.stringify(await runUgcLinkHealthBatch(env, 50)).slice(0, 600) };
});
