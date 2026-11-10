import type {Env} from '../types';
const GRAPH='https://graph.facebook.com/v22.0', ACCOUNT='17841466350261166';

// Never treat a truncated or failed Graph list as an empty list.
async function graphList(path:string,token:string) {
  let url:string|null=GRAPH+path+(path.includes('?')?'&':'?')+'limit=100';
  const out:any[]=[];
  for(let page=0;url&&page<30;page++){
    const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.hostname!=='graph.facebook.com')throw Error('collab_untrusted_pagination');
    const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20_000)});
    const data=await response.json() as any;
    if(!response.ok||data.error||!Array.isArray(data.data))throw Error('collab_list_unavailable');
    out.push(...data.data);url=data.paging?.next??null;
  }
  if(url)throw Error('collab_list_incomplete');
  return out;
}

// Invites are scoped to the exact creator, saved before the external action,
// then checked against the accepted-media list. Ambiguous sends are never replayed.
export async function reviewRoundCollab(env:Env,creatorId:string,handle:string){
  const token=(env as any).META_IG_MESSAGING_TOKEN as string|undefined;
  if(!token)return {status:'needs_review',reason:'collab_token_unavailable'};
  const profile=await env.DB.prepare(`SELECT c.id FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id
    WHERE c.id=?1 AND c.archived_at IS NULL AND p.platform='instagram' AND p.normalized_handle=?2 LIMIT 1`).bind(creatorId,handle.toLowerCase()).first();
  if(!profile)return {status:'needs_review',reason:'collab_creator_identity_unavailable'};
  try {
    const invites=await graphList(`/${ACCOUNT}/collaboration_invites?fields=media_id,media_owner_username`,token);
    const mine=invites.filter(x=>String(x.media_owner_username??'').toLowerCase()===handle.toLowerCase());
    if(!mine.length){
      const unresolved=await env.DB.prepare(`SELECT 1 present FROM crm_sync_state WHERE key LIKE 'diana_collab_action:%'
        AND json_valid(value) AND json_extract(value,'$.creator_id')=?1 AND json_extract(value,'$.status')='attempting' LIMIT 1`).bind(creatorId).first();
      return unresolved?{status:'needs_review',reason:'collab_prior_attempt_requires_readback'}:{status:'verified',outcome:'no_pending_invite'};
    }
    const results=[];
    for(const invite of mine){
      const media=String(invite.media_id??'');
      if(!/^\d{5,40}$/.test(media)){results.push({status:'needs_review',reason:'collab_media_identity_missing'});continue;}
      const key='diana_collab_action:'+media, intent=JSON.stringify({status:'attempting',creator_id:creatorId,media_id:media});
      const claim=await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(key,intent,Date.now()).run();
      if(Number(claim.meta.changes)!==1){results.push({status:'needs_review',reason:'collab_prior_attempt_requires_readback',media_id:media});continue;}
      try {
        const response=await fetch(`${GRAPH}/${ACCOUNT}/collaboration_invites?media_id=${encodeURIComponent(media)}&accept=true`,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20_000)});
        const body=await response.json() as any;
        if(!response.ok||!body?.success)throw Error('collab_accept_not_confirmed');
        const [remaining,accepted]=await Promise.all([
          graphList(`/${ACCOUNT}/collaboration_invites?fields=media_id,media_owner_username`,token),
          graphList(`/${ACCOUNT}/collaborative_media?fields=id,permalink`,token)]);
        if(remaining.some(x=>String(x.media_id)===media)||!accepted.some(x=>String(x.id)===media))throw Error('collab_readback_not_confirmed');
        const proof={status:'verified',creator_id:creatorId,media_id:media,checked_at:new Date().toISOString()};
        await env.DB.prepare('UPDATE crm_sync_state SET value=?2,updated_at=?3 WHERE key=?1 AND value=?4').bind(key,JSON.stringify(proof),Date.now(),intent).run();
        const saved=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(key).first<{value:string}>();
        if(!saved||JSON.parse(saved.value).status!=='verified')throw Error('collab_receipt_not_saved');
        results.push(proof);
      } catch(error){results.push({status:'needs_review',reason:String((error as Error)?.message??'collab_unknown').slice(0,100),media_id:media});}
    }
    return results.every(x=>x.status==='verified')?{status:'verified',outcome:'accepted',results}:{status:'needs_review',reason:'collab_unverified',results};
  } catch(error){return {status:'needs_review',reason:String((error as Error)?.message??'collab_unavailable').slice(0,100)};}
}
