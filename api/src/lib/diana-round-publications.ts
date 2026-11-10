import type {Env} from '../types';
import {instagramPostFallback,instagramPostTarget} from './ugc-apify.mjs';
import {reviewContent} from './ugc-content-review';

// Publication and author are verified together. No metric is written here;
// Apify uses the existing shared budget and cache from the publication lane.
export async function reviewRoundPublications(env:Env,creatorId:string,handle:string) {
  const rows=(await env.DB.prepare("SELECT id,content_url FROM ugc_content WHERE creator_id=?1 AND content_url IS NOT NULL AND TRIM(content_url)<>'' ORDER BY id")
    .bind(creatorId).all<{id:string;content_url:string}>()).results??[];
  if(!rows.length)return {status:'needs_review',reason:'publication_link_unavailable',results:[]};
  const results=[];
  for(const row of rows){
    const target=instagramPostTarget(row.content_url);
    if(!target){results.push({id:row.id,status:'needs_review',reason:'publication_platform_unavailable'});continue;}
    try {
      const observation=await instagramPostFallback(env,{url:row.content_url,cacheForMs:24*3600_000});
      if(observation.status!=='ok'){results.push({id:row.id,status:'needs_review',reason:'publication_'+String(observation.status??'unknown')});continue;}
      if(String(observation.ownerUsername??'').toLowerCase()!==handle.toLowerCase()){
        results.push({id:row.id,status:'needs_review',reason:'publication_author_mismatch'});continue;
      }
      await reviewContent(env,row.id,{verdict:'published',author_verified:true,publication_verified:true,
        evidence:`Original ${target.url}; exact shortcode and creator @${handle} verified by Apify at ${observation.observedAt}.`});
      const saved=await env.DB.prepare('SELECT link_status,link_check_note FROM ugc_content WHERE id=?1 AND creator_id=?2').bind(row.id,creatorId).first<{link_status:string;link_check_note:string}>();
      if(saved?.link_status!=='active'||!saved.link_check_note)throw Error('publication_receipt_not_saved');
      results.push({id:row.id,status:'verified',checked_at:observation.observedAt});
    } catch(error){results.push({id:row.id,status:'needs_review',reason:String((error as Error)?.message??'publication_unavailable').slice(0,100)});}
  }
  return results.every(x=>x.status==='verified')?{status:'verified',results}:{status:'needs_review',reason:'publication_unverified',results};
}
