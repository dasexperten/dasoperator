import { erpWorker, type BaseEnv } from '../../_shared/run';
import { runUgcLinkHealthBatch } from '../../../api/src/lib/ugc-link-health';
import { captureDmLinks } from '../../../api/src/lib/ugc-dm-links';
import { confirmPendingContent } from '../../../api/src/lib/ugc-content-confirm';
import { fillMissingViews } from '../../../api/src/lib/ugc-views-fill.mjs';
import type {Env as ErpEnv} from '../../../api/src/types';

interface LinkHealthEnv extends BaseEnv { APIFY_TOKEN?: string; APIFY_DAILY_BUDGET_USD?: string }

export default erpWorker<LinkHealthEnv>('erp-ugc-postlink', async (env, dry) => {
  if (dry) return { note: 'dry · UGC links not fetched' };
  // Owner 2026-11-18, priority 1: plays first. Each reel is saved as soon as it is read, so a night cut
  // off later (17 and 18.11) no longer loses them. The rest of the night shares what time is left.
  const started=Date.now();
  const views=await fillMissingViews(env as unknown as ErpEnv,{limit:40,budgetMs:4*60_000}).catch((e:unknown)=>({failed:String((e as Error)?.message??e).slice(0,120)}));
  const captured=await captureDmLinks(env as unknown as ErpEnv,{signalAlarms:false});
  const links=await runUgcLinkHealthBatch(env, 30);
  // Owner 2026-11-18: the night also confirms waiting reels (author and our product) and brings their numbers.
  const {pending_ids:_p,ids:_i,...content}=await confirmPendingContent(env as unknown as ErpEnv,{limit:12,budgetMs:Math.max(30_000,11*60_000-(Date.now()-started))}).catch(()=>({pending_ids:[],ids:[],failed:true} as any));
  return { note: JSON.stringify({views,captured,...links,content}).slice(0, 800) };
});
