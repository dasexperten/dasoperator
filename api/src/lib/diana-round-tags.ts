import type {Env} from '../types';
import {publicationLink,contentReviewKey} from './ugc-publication-links.mjs';
import {reviewContent} from './ugc-content-review';
// @ts-expect-error plain JS module
import {acceptInvite} from './diana-direct-collab.mjs';

// Owner 2026-11-12 (astilife__): she had published two reels on 08.11 and we still asked her
// «когда ролик?». Instagram's official list of media that tag or co-author us names every such
// reel and its author. Before the round goes to anyone, every listed reel of a blogger who has a
// card is recorded in the ERP and she moves to «posted», so the round never asks for a video
// that already exists. Pending co-author invitations are accepted here too: always yes (05.11).
const ROOT='https://graph.facebook.com/v21.0/', PAGE='1697038263872226', IG='17841466350261166';
async function get(path:string,key:string):Promise<any>{
  const r=await fetch(ROOT+path+(path.includes('?')?'&':'?')+'access_token='+encodeURIComponent(key),{signal:AbortSignal.timeout(20_000)});
  const b:any=await r.json().catch(()=>null);if(!r.ok||b?.error)throw Error('tags_meta_'+r.status);return b;
}
export async function recordTaggedReels(env:Env,sinceMs=30*86_400_000,now=Date.now()){
  const token=(env as any).META_IG_MESSAGING_TOKEN as string|undefined;
  if(!token)return {status:'needs_review',reason:'tags_token_unavailable',recorded:0,accepted:0};
  const page=String((await get(`${PAGE}?fields=access_token`,token)).access_token??'');
  if(!page)return {status:'needs_review',reason:'tags_page_token_unavailable',recorded:0,accepted:0};
  let accepted=0;
  const invites:any[]=(await get(`${IG}/collaboration_invites?limit=50`,page).catch(()=>({data:[]}))).data??[];
  for(const invite of invites){if(/^\d{5,40}$/.test(String(invite.media_id??''))&&await acceptInvite({page,mediaId:String(invite.media_id)}).catch(()=>false))accepted++;}
  const tags:any[]=[];let after='';
  for(let i=0;i<3;i++){
    const r=await get(`${IG}/tags?fields=id,permalink,timestamp,username&limit=50${after?'&after='+encodeURIComponent(after):''}`,page);
    tags.push(...(r.data??[]));after=String(r.paging?.cursors?.after??'');if(!r.paging?.next||!after)break;
  }
  let recorded=0;const handles:string[]=[];
  for(const tag of tags){
    const at=Date.parse(String(tag.timestamp??''));const handle=String(tag.username??'').toLowerCase();
    const link=publicationLink(String(tag.permalink??''));
    if(!handle||!link||!Number.isFinite(at)||now-at>sinceMs)continue;
    const profile=await env.DB.prepare(`SELECT p.id,p.creator_id FROM ugc_creator_platforms p JOIN ugc_creators c ON c.id=p.creator_id
      WHERE p.platform='instagram' AND p.normalized_handle=?1 AND c.archived_at IS NULL LIMIT 1`).bind(handle).first<{id:string;creator_id:string}>();
    if(!profile)continue; // never invent a creator
    const known=await env.DB.prepare(`SELECT 1 x FROM ugc_content WHERE creator_id=?1 AND content_url LIKE ?2 LIMIT 1`).bind(profile.creator_id,'%'+link.code+'%').first();
    const settled=await env.DB.prepare('SELECT 1 x FROM crm_sync_state WHERE key=?1').bind(contentReviewKey(profile.creator_id,link.key)).first();
    if(known||settled)continue; // already recorded, or reviewed and rejected before
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(profile.creator_id+':'+link.key));
    const id='ugcc_tag_'+[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
    const ins=await env.DB.prepare(`INSERT INTO ugc_content (id,creator_id,creator_platform_id,content_url,content_type,imported_at,updated_at,product_status,product_evidence)
      VALUES (?1,?2,?3,?4,?5,?6,?6,'queued',?7) ON CONFLICT(id) DO NOTHING`).bind(id,profile.creator_id,profile.id,link.url,link.kind,now,
      JSON.stringify({discovery:'instagram_tags',sender:handle,source_message_at:new Date(at).toISOString(),publication_platform:'instagram',author_verified:true,our_product:null})).run();
    if(!Number(ins.meta?.changes??0))continue;
    await reviewContent(env,id,{verdict:'published',author_verified:true,publication_verified:true,published_at:new Date(at).toISOString(),
      evidence:`Official Instagram list of media that tag us: ${link.url} by @${handle}, published ${new Date(at).toISOString()}.`});
    recorded++;handles.push(handle);
  }
  return {status:'verified',recorded,accepted,handles:handles.slice(0,40)};
}
