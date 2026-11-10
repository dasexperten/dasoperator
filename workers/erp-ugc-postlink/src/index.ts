import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runUgcLinkHealthBatch } from '../../../api/src/lib/ugc-link-health';
import { captureDmLinks } from '../../../api/src/lib/ugc-dm-links';
import type {Env as ErpEnv} from '../../../api/src/types';

interface LinkHealthEnv extends BaseEnv { APIFY_TOKEN?: string; APIFY_DAILY_BUDGET_USD?: string }

export default erpWorker<LinkHealthEnv>('erp-ugc-postlink', async (env, dry) => {
  if (dry) return { note: 'dry · UGC links not fetched' };
  const captured=await captureDmLinks(env as unknown as ErpEnv,{signalAlarms:false});
  return { note: JSON.stringify({captured,...await runUgcLinkHealthBatch(env, 50)}).slice(0, 600) };
});
