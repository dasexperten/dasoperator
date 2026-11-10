// Owner 06.11: record discovered publication URLs immediately as queued content.
// Sender/profile is provenance, not verified authorship. Only Diana can confirm.
import type { Env } from '../types';
import { publicationLinks, publicationLink, contentReviewKey } from './ugc-publication-links.mjs';
const READ_BATCH=50;
export const REEL_CHECKED_KEY=(code:string)=>`diana_reel_checked:${code}`;
const ALARM_KEY=(cid:string)=>`diana_round_alarm:${cid}`;

export async function captureDmLinks(env:Env,options:{signalAlarms?:boolean}={}):Promise<{added:number}> {
  const rows=(await env.DB.prepare(`SELECT conversation_id,lower(from_username) h,text,created_at FROM ugc_ig_messages
    WHERE direction='in' AND text LIKE '%://%' AND from_username IS NOT NULL ORDER BY created_at DESC LIMIT 400`)
    .all<{conversation_id:string;h:string;text:string;created_at:string}>()).results??[];
  const links=rows.flatMap(r=>publicationLinks(r.text).map(link=>({...r,...link})));
  if(!links.length)return {added:0};
  const known=new Map<string,{creator_id:string;id:string}>();
  const handles=[...new Set(links.map(r=>r.h))];
  for(let i=0;i<handles.length;i+=READ_BATCH){
    const batch=handles.slice(i,i+READ_BATCH);
    const profiles=(await env.DB.prepare(`SELECT p.normalized_handle h,p.creator_id,p.id FROM ugc_creator_platforms p JOIN ugc_creators c ON c.id=p.creator_id
      WHERE p.platform='instagram' AND c.archived_at IS NULL AND p.normalized_handle IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all<{h:string;creator_id:string;id:string}>()).results??[];
    for(const profile of profiles)known.set(profile.h,profile);
  }
  const targetProfiles=new Map<string,string>(),creatorIds=[...new Set([...known.values()].map(p=>p.creator_id))];
  for(let i=0;i<creatorIds.length;i+=READ_BATCH){
    const batch=creatorIds.slice(i,i+READ_BATCH);
    const profiles=(await env.DB.prepare(`SELECT id,creator_id,platform FROM ugc_creator_platforms WHERE creator_id IN (${batch.map(()=>'?').join(',')}) ORDER BY id`).bind(...batch).all<{id:string;creator_id:string;platform:string}>()).results??[];
    for(const p of profiles)if(!targetProfiles.has(p.creator_id+':'+p.platform))targetProfiles.set(p.creator_id+':'+p.platform,p.id);
  }
  const settled=new Set<string>(),existing=new Set<string>(),codes=[...new Set(links.map(r=>r.code))];
  for(let i=0;i<codes.length;i+=READ_BATCH){
    const batch=codes.slice(i,i+READ_BATCH);
    const content=(await env.DB.prepare(`SELECT creator_id,content_url,product_status FROM ugc_content WHERE ${batch.map(()=> 'content_url LIKE ?').join(' OR ')}`).bind(...batch.map(code=>'%'+code+'%')).all<{creator_id:string;content_url:string;product_status:string}>()).results??[];
    for(const row of content){const link=publicationLink(row.content_url);if(!link)continue;existing.add(row.creator_id+':'+link.key);if(row.product_status==='identified')settled.add(link.key);}
  }
  const markerKeys=[...new Set(links.flatMap(r=>{
    const profile=known.get(r.h);
    return [...(profile?[contentReviewKey(profile.creator_id,r.key)]:[]),...(r.platform==='instagram'?[REEL_CHECKED_KEY(r.code)]:[])];
  }))],markers=new Set<string>();
  for(let i=0;i<markerKeys.length;i+=READ_BATCH){
    const batch=markerKeys.slice(i,i+READ_BATCH);
    const found=(await env.DB.prepare(`SELECT key FROM crm_sync_state WHERE key IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all<{key:string}>()).results??[];
    for(const row of found)markers.add(row.key);
  }
  const byChat=new Map<string,{h:string;at:string;urls:Set<string>}>(),writes:D1PreparedStatement[]=[];
  for(const r of links){
    const profile=known.get(r.h);
    if(settled.has(r.key) || (r.platform==='instagram'&&markers.has(REEL_CHECKED_KEY(r.code))) || profile&&markers.has(contentReviewKey(profile.creator_id,r.key)))continue;
    const alarm=byChat.get(r.conversation_id)??{h:r.h,at:r.created_at,urls:new Set<string>()};alarm.urls.add(r.url);if(r.created_at>alarm.at)alarm.at=r.created_at;byChat.set(r.conversation_id,alarm);
    if(!profile)continue; // keep alarm, never invent a creator.
    const identity=profile.creator_id+':'+r.key;
    if(existing.has(identity))continue;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
    const id='ugcc_dm_'+[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
    writes.push(env.DB.prepare(`INSERT INTO ugc_content
      (id,creator_id,creator_platform_id,content_url,content_type,imported_at,updated_at,product_status,product_evidence)
      SELECT ?1,?2,?3,?4,?5,?6,?6,'queued',?7 WHERE NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?8)
      ON CONFLICT(id) DO NOTHING`).bind(id,profile.creator_id,targetProfiles.get(profile.creator_id+':'+r.platform)??profile.id,r.url,r.kind,Date.now(),
      JSON.stringify({discovery:'instagram_direct',sender:r.h,source_message_at:r.created_at,publication_platform:r.platform,author_verified:false,our_product:null}),contentReviewKey(profile.creator_id,r.key)));
    existing.add(identity);
  }
  let added=0;
  for(let i=0;i<writes.length;i+=READ_BATCH){const results=await env.DB.batch(writes.slice(i,i+READ_BATCH));added+=results.reduce((n,r)=>n+Number(r.meta?.changes??0),0);}
  if(options.signalAlarms!==false)for(const [cid,entry] of byChat){
    const prior=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(ALARM_KEY(cid)).first<{value:string}>();
    let value:Record<string,any>={};try{value=JSON.parse(prior?.value??'{}')??{};}catch{}
    const knownLinks=new Set<string>(Array.isArray(value.links)?value.links:[]),fresh=[...entry.urls].filter(u=>!knownLinks.has(u));
    if(!fresh.length)continue;
    const reasons=new Set<string>(String(value.reason??'').split(',').filter(Boolean));reasons.add('reel_link');
    const next={...value,handle:value.handle??entry.h,cid,at:value.at&&value.at>entry.at?value.at:entry.at,reason:[...reasons].join(','),links:[...knownLinks,...fresh],rang_at:new Date().toISOString()};
    await env.DB.prepare('INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(ALARM_KEY(cid),JSON.stringify(next),Date.now()).run();
  }
  return {added};
}
