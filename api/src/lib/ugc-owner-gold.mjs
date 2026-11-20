// Owner 2026-11-20: «если я пишу лично кому-то golden list, gold список или золотой список,
// ты должна понимать, что этого блогера ставишь в золотой список». Diana never promises the
// Gold list herself before the stage is Gold, so such words in OUR message to a blogger who
// is not Gold yet are the Owner's own hand. The stage change wakes the usual Gold welcome.
const GOLD=/золот\S*\s+(?:спис|лист)|gold(?:en)?[\s-]*(?:list|лист|спис)|голд\S*[\s-]*(?:лист|спис)/i;
/** True when one of our own messages names the Gold list. */
export function ownerSaidGold(texts){return (texts??[]).some(x=>GOLD.test(String(x??'')));}
/** Gold for a live card; a closed card (refused, unfit, rival, owner, archived) is never reopened. */
export async function markOwnerGold(env,creatorId,now=Date.now()){
 if(!creatorId)return false;
 const r=await env.DB.prepare("UPDATE ugc_creators SET lifecycle_stage='gold',updated_at=?2 WHERE id=?1 AND COALESCE(lifecycle_stage,'') NOT IN ('gold','refused','unfit','rival','owner') AND archived_at IS NULL").bind(creatorId,now).run();
 return Number(r.meta?.changes??0)>0;
}
