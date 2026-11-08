import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runUgcLinkHealthBatch } from '../../../api/src/lib/ugc-link-health';

interface LinkHealthEnv extends BaseEnv { APIFY_TOKEN?: string; APIFY_DAILY_BUDGET_USD?: string }

export default erpWorker<LinkHealthEnv>('erp-ugc-link-health', async (env, dry) => {
  if (dry) return { note: 'dry · UGC links not fetched' };
  return { note: JSON.stringify(await runUgcLinkHealthBatch(env, 50)).slice(0, 600) };
});
