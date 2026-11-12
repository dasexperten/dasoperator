// Owner 2026-11-12 (anyanapanike): Instagram passes a collab invitation or a shared reel to
// the chat as an empty «unsupported» message. The same publication is visible through two
// official lists: pending collab invitations and media that tag or co-author us. Diana
// looks there first, so she never answers «не могу разобрать» to a published reel.
const ROOT='https://graph.facebook.com/v21.0/';
const PAGE='1697038263872226', IG='17841466350261166';
async function get(fetchImpl,path,key){
  const r=await fetchImpl(ROOT+path+(path.includes('?')?'&':'?')+'access_token='+encodeURIComponent(key),{signal:AbortSignal.timeout(20000)});
  const b=await r.json().catch(()=>null);if(!r.ok||b?.error)throw Error('collab_meta_'+r.status);return b;
}
/** Newest publication of this creator: a pending invite, or a reel that tags/co-authors us
 *  within `windowMs` of the chat message. Returns null when none matches. */
export async function findPublication({fetchImpl=fetch,token,handle,at,windowMs=30*60000,seen=async()=>false}){
  const name=String(handle??'').toLowerCase().replace(/^@/,'');if(!name||!token)return null;
  const page=(await get(fetchImpl,`${PAGE}?fields=access_token`,token)).access_token;if(!page)return null;
  const invites=(await get(fetchImpl,`${IG}/collaboration_invites?limit=50`,page).catch(()=>({data:[]}))).data??[];
  const invite=invites.find(x=>String(x.media_owner_username??'').toLowerCase()===name);
  if(invite)return {kind:'invite',media_id:String(invite.media_id),caption:String(invite.caption??'').slice(0,600),page};
  const tags=(await get(fetchImpl,`${IG}/tags?fields=id,caption,permalink,timestamp,username,media_type&limit=50`,page).catch(()=>({data:[]}))).data??[];
  const t=Number(at)||Date.now();
  // 2026-11-12: a blank message is her reel only when the reel appeared within half an hour of it
  // (a collab invite lands within seconds) or when this reel was never matched before and is at most
  // three days old. Otherwise a later disappearing photo would be thanked as «the reel» again.
  const mine=tags.filter(x=>String(x.username??'').toLowerCase()===name);
  const fresh=[];for(const x of mine){const d=Math.abs(Date.parse(x.timestamp)-t);if(d<=windowMs||(d<=3*86400000&&!(await seen(String(x.id)))))fresh.push(x);}
  const tag=fresh
    .sort((a,b)=>Math.abs(Date.parse(a.timestamp)-t)-Math.abs(Date.parse(b.timestamp)-t))[0];
  return tag?{kind:'tag',media_id:String(tag.id),permalink:String(tag.permalink??''),caption:String(tag.caption??'').slice(0,600),published_at:tag.timestamp,page}:null;
}
/** Owner 2026-11-05: a co-author invitation is always yes. */
export async function acceptInvite({fetchImpl=fetch,page,mediaId}){
  const r=await fetchImpl(ROOT+`${IG}/collaboration_invites?media_id=${encodeURIComponent(mediaId)}&accept=true&access_token=${encodeURIComponent(page)}`,{method:'POST',signal:AbortSignal.timeout(20000)});
  const b=await r.json().catch(()=>null);return Boolean(r.ok&&!b?.error&&(b?.success!==false));
}
