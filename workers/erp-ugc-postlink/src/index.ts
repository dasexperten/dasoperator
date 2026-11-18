import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runUgcLinkHealthBatch } from '../../../api/src/lib/ugc-link-health';
import { captureDmLinks } from '../../../api/src/lib/ugc-dm-links';
import { confirmPendingContent } from '../../../api/src/lib/ugc-content-confirm';
import type {Env as ErpEnv} from '../../../api/src/types';

interface LinkHealthEnv extends BaseEnv { APIFY_TOKEN?: string; APIFY_DAILY_BUDGET_USD?: string }

export default erpWorker<LinkHealthEnv>('erp-ugc-postlink', async (env, dry) => {
  if (dry) return { note: 'dry · UGC links not fetched' };
  const captured=await captureDmLinks(env as unknown as ErpEnv,{signalAlarms:false});
  const links=await runUgcLinkHealthBatch(env, 50);
  // Owner 2026-11-18: the night also confirms waiting reels (author and our product) and brings their numbers.
  const {pending_ids:_p,ids:_i,...content}=await confirmPendingContent(env as unknown as ErpEnv,{limit:12,budgetMs:5*60_000}).catch(()=>({pending_ids:[],ids:[],failed:true} as any));
  return { note: JSON.stringify({captured,...links,content}).slice(0, 800) };
});
