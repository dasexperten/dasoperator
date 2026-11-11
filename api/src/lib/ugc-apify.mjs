import { isInstagramAvatarUrl } from './ugc-blogger-profile-parse.mjs';

// Both workers reserve the full run ceiling, not an estimate of the bill.
const CAP = 10_000; // micro USD = $0.01
const DAY = 86_400_000;
const STALE_START = 6 * 3_600_000;
const count = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
const handle = x => typeof x === 'string' && /^[a-z0-9_.]{1,30}$/i.test(x) ? x.toLowerCase() : null;
export function instagramPostTarget(value) {
  try {
    const u = new URL(value);
    const m = u.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/);
    if (u.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(u.hostname) || u.port || u.username || u.password || !m) return null;
    return { shortcode:m[2], url:`https://www.instagram.com/${m[1]}/${m[2]}/` };
  } catch { return null; }
}
export function parseApifyProfile(items, expected) {
  const matching = Array.isArray(items) ? items.filter(x => x && !x.error && handle(x.username) === handle(expected)) : [];
  if (matching.length !== 1) return null;
  const x=matching[0], followers=count(x.followersCount), posts=count(x.postsCount);
  const avatar = [x.profilePicUrlHD,x.profilePicUrl].find(isInstagramAvatarUrl) || null;
  const recent = Array.isArray(x.latestPosts) ? x.latestPosts.filter(p => Number.isFinite(Date.parse(p.timestamp)) && count(p.likesCount) !== null && count(p.commentsCount) !== null).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,6) : [];
  // Missing interactions are never treated as zero. Require a complete six-post sample.
  const er = followers > 0 && recent.length === 6 ? Math.round(recent.reduce((s,p)=>s+p.likesCount+p.commentsCount,0)/6/followers*10000)/100 : null;
  if (followers === null && posts === null && !avatar && er === null) return null;
  return {followers,posts,avatar,er,sample:er === null ? 0 : 6};
}
export function parseApifyPost(items, expected) {
  const target=instagramPostTarget(expected);
  if (!target || !Array.isArray(items)) return null;
  const matching=items.filter(x => x && !x.error && x.shortCode === target.shortcode && (!x.url || instagramPostTarget(x.url)?.shortcode === target.shortcode) && handle(x.ownerUsername));
  if (matching.length !== 1) return null;
  const x=matching[0];
  return {...target,ownerUsername:handle(x.ownerUsername),views:count(x.videoPlayCount) ?? count(x.videoViewCount),likes:count(x.likesCount),comments:count(x.commentsCount)};
}
const changes = r => Number(r?.meta?.changes || 0);
export function yerevanBudgetDay(now) { return new Date(now+4*3_600_000).toISOString().slice(0,10); }
async function reserve(db,now,limit) {
  const key=`ugc-apify:budget:${yerevanBudgetDay(now)}`;
  await db.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,'0',Math.floor(now/1000)).run();
  return changes(await db.prepare('UPDATE crm_sync_state SET value=CAST(CAST(value AS INTEGER)+? AS TEXT),updated_at=? WHERE key=? AND CAST(value AS INTEGER)+?<=?').bind(CAP,Math.floor(now/1000),key,CAP,limit).run()) === 1;
}
async function fallback(env,kind,target,cacheForMs) {
  const limit=Math.min(1,Number(env.APIFY_DAILY_BUDGET_USD));
  if (!env.APIFY_TOKEN || !(limit>0) || !env.DB) return {status:'disabled'};
  const now=Date.now(), key=`ugc-apify:${kind}:${kind==='profile'?target:target.shortcode}`;
  const db=env.DB;
  const read=async()=>{ const row=await db.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first(); try {return row ? {raw:row.value,state:JSON.parse(row.value)} : null;} catch {return {raw:row?.value,state:{phase:'ambiguous'}};} };
  const write=async state=>db.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=?').bind(JSON.stringify(state),Math.floor(Date.now()/1000),key).run();
  let previous=await read(), state=previous?.state;
  if (state?.phase==='done' && now-state.at<Math.max(0,Number(cacheForMs)||0)) return state.result;
  // A start cut off mid-call (a night job dropped on 10-11 Nov 2026) must not block the
  // post forever. Within six hours an unconfirmed start stays inert; after that one retry
  // may cost at most one extra capped run ($0.01).
  if (state && ['starting','ambiguous'].includes(state.phase) && now-(Number(state.at)||0)<STALE_START) return {status:'unknown'};
  const request=async(path,init={})=>{
    const response=await fetch(`https://api.apify.com/v2/${path}`,{...init,headers:{Authorization:`Bearer ${env.APIFY_TOKEN}`,'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(40_000)});
    if (!response.ok) throw new Error('Apify request failed');
    return response.json();
  };
  if (state?.phase !== 'running') {
    const starting={phase:'starting',at:now};
    const acquired=previous
      ? changes(await db.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?').bind(JSON.stringify(starting),Math.floor(now/1000),key,previous.raw).run())
      : changes(await db.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify(starting),Math.floor(now/1000)).run());
    if (!acquired) return {status:'pending'};
    if (!await reserve(db,now,Math.floor(limit*1_000_000))) {
      // Keep the last observation but allow a later day to try again.
      if (previous) await write(previous.state);
      else await db.prepare('DELETE FROM crm_sync_state WHERE key=?').bind(key).run();
      return {status:'budget_exhausted'};
    }
    try {
      const actor=kind==='profile'?'apify~instagram-profile-scraper':'apify~instagram-scraper';
      const input=kind==='profile'?{usernames:[target],includeAboutSection:false}:{directUrls:[target.url],resultsType:'posts',resultsLimit:1,addParentData:false};
      const response=await request(`acts/${actor}/runs?maxTotalChargeUsd=0.01&waitForFinish=30&timeout=90`,{method:'POST',body:JSON.stringify(input)});
      if (!/^[A-Za-z0-9]+$/.test(response.data?.id || '')) throw new Error('Missing run id');
      state={phase:'running',at:now,runId:response.data.id};
      await write(state);
    } catch {
      // POST may have reached Apify. Never create a second charged run automatically.
      await write({phase:'ambiguous',at:now});
      return {status:'unknown'};
    }
  }
  try {
    const {data:run}=await request(`actor-runs/${state.runId}`);
    if (!['SUCCEEDED','FAILED','TIMED-OUT','ABORTED'].includes(run.status)) return {status:'pending',runId:state.runId};
    let parsed=null;
    if (run.status==='SUCCEEDED' && /^[A-Za-z0-9]+$/.test(run.defaultDatasetId || '')) {
      const items=await request(`datasets/${run.defaultDatasetId}/items?format=json&clean=true&limit=2`);
      parsed=kind==='profile'?parseApifyProfile(items,target):parseApifyPost(items,target.url);
    }
    const observedAt=Number.isFinite(Date.parse(run.finishedAt))?new Date(run.finishedAt).toISOString():new Date(state.at).toISOString();
    const result={status:parsed?'ok':'unknown',source:'apify',observedAt,runId:state.runId,...(parsed||{})};
    await write({phase:'done',at:Date.parse(observedAt),result});
    return result;
  } catch { return {status:'pending',runId:state.runId}; }
}
export async function instagramProfileFallback(env,{handle:username,cacheForMs=DAY}) {
  const target=handle(username);
  return target ? fallback(env,'profile',target,cacheForMs) : {status:'unknown'};
}
export async function instagramPostFallback(env,{url,cacheForMs=DAY}) {
  const target=instagramPostTarget(url);
  return target ? fallback(env,'post',target,cacheForMs) : {status:'unknown'};
}
