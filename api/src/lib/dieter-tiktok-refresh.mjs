// Rotate only the existing publisher grant; never publish media here.
// A durable intent forbids a second provider call when the first result is unknown.
const KEY='dieter:tiktok-business-refresh:v1';
const APP='7706160588917342228', ACCOUNT='dasbroadcast';
const PATH='SECRETS/company/tiktok-business-publisher.md';
const VAULTS=[['dasexperten/das-architektura','main'],['dasexperten/organizacia','secrets']];
const HOUR=3600000;
const MUTABLE=['TIKTOK_BUSINESS_ACCESS_TOKEN','TIKTOK_BUSINESS_REFRESH_TOKEN','TIKTOK_BUSINESS_SCOPE','TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT','TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT'];
const shape=s=>s.split('\n').filter(line=>!MUTABLE.some(k=>line.startsWith(k+'='))).join('\n');
const fieldsUnique=s=>MUTABLE.every(k=>(s.match(new RegExp('^'+k+'=', 'gm'))||[]).length===1);
const sha=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const parse=s=>Object.fromEntries([...s.matchAll(/^(TIKTOK_BUSINESS_[A-Z_]+)=(.*)$/gm)].map(m=>[m[1],m[2].trim()]));
const encode=s=>btoa(unescape(encodeURIComponent(s)));
const decode=s=>decodeURIComponent(escape(atob(s.replace(/\s/g,''))));
function valid(g){return g.TIKTOK_BUSINESS_APP_ID===APP&&g.TIKTOK_BUSINESS_USERNAME===ACCOUNT&&g.TIKTOK_BUSINESS_APP_SECRET&&g.TIKTOK_BUSINESS_OPEN_ID&&g.TIKTOK_BUSINESS_ACCESS_TOKEN&&g.TIKTOK_BUSINESS_REFRESH_TOKEN&&['video.upload','video.publish','video.list'].every(x=>(g.TIKTOK_BUSINESS_SCOPE||'').split(/[\s,]+/).includes(x))&&Number.isFinite(Date.parse(g.TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT));}
export async function refreshDieterTikTok(env,{fetchImpl=fetch,now=Date.now}={}){
 if(!env.GITHUB_TOKEN||!env.DB)return {status:'unavailable'};
 const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'DasExperten-TikTok-Grant/1.0'};
 const get=async ([repo,branch])=>{const r=await fetchImpl(`https://api.github.com/repos/${repo}/contents/${PATH}?ref=${branch}`,{headers,redirect:'manual'});if(!r.ok)throw Error('vault_read');const j=await r.json();return {sha:j.sha,text:decode(j.content)};};
 const put=async ([repo,branch],previous,text)=>{const r=await fetchImpl(`https://api.github.com/repos/${repo}/contents/${PATH}`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:'Refresh TikTok Business publisher grant',branch,sha:previous.sha,content:encode(text)}),redirect:'manual'});if(!r.ok)throw Error('vault_write');const after=await get([repo,branch]);if(after.text!==text)throw Error('vault_readback');};
 const row=async()=>env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(KEY).first();
 const save=async(old,value)=>{const result=await env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?').bind(JSON.stringify(value),now(),KEY,old).run();return !!result.meta.changes;};
 try{
  let master=await get(VAULTS[0]);let grant=parse(master.text);if(!valid(grant))return {status:'invalid_grant'};
  const oldCardHash=await sha(master.text);
  let stored=await row();let state=stored?JSON.parse(stored.value):null;
  if(state?.state==='requested'){
   // If master changed, the response was durably saved there: repair mirror only.
   if(state.oldHash===oldCardHash)return {status:'outcome_unknown_no_retry'};
   if(!fieldsUnique(master.text)||await sha(shape(master.text))!==state.staticHash||Date.parse(grant.TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT)<=state.at||!Number.isFinite(Date.parse(grant.TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT))||Date.parse(grant.TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT)<=state.at)return {status:'master_conflict'};
   const mirror=await get(VAULTS[1]);
   if(await sha(mirror.text)!==state.oldHash&&mirror.text!==master.text)return {status:'mirror_conflict'};
   if(mirror.text!==master.text)await put(VAULTS[1],mirror,master.text);
   if(!await save(stored.value,{state:'complete',at:now()}))return {status:'concurrent'};
   return {status:'mirror_recovered'};
  }
  const expires=Date.parse(grant.TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT);
  const refreshExpires=Date.parse(grant.TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT);
  if(!Number.isFinite(refreshExpires)||refreshExpires<=now())return {status:'refresh_expired'};
  if(!fieldsUnique(master.text))return {status:'invalid_grant_fields'};
  const mirror=await get(VAULTS[1]);if(master.text!==mirror.text)return {status:'vault_mismatch'};
  // Check both repos are writable before risking one-time token rotation.
  for(const [repo] of VAULTS){const r=await fetchImpl(`https://api.github.com/repos/${repo}`,{headers,redirect:'manual'});if(!r.ok||(await r.json())?.permissions?.push!==true)return {status:'vault_write_permission_missing'};}
  if(expires-now()>2*HOUR)return {status:'not_due'};
  const started=now();
  const intent=JSON.stringify({state:'requested',oldHash:oldCardHash,staticHash:await sha(shape(master.text)),at:started});
  let won;
  if(stored)won=await save(stored.value,JSON.parse(intent));
  else {const r=await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(KEY,intent,now()).run();won=!!r.meta.changes;}
  if(!won)return {status:'concurrent'};
  let response;
  try{response=await fetchImpl('https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:grant.TIKTOK_BUSINESS_APP_ID,client_secret:grant.TIKTOK_BUSINESS_APP_SECRET,grant_type:'refresh_token',refresh_token:grant.TIKTOK_BUSINESS_REFRESH_TOKEN}),redirect:'manual'});}catch{return {status:'outcome_unknown_no_retry'};}
  let body;try{body=await response.json();}catch{return {status:'outcome_unknown_no_retry'};}
  const d=body?.data,scopes=Array.isArray(d?.scope)?d.scope:String(d?.scope||'').split(/[\s,]+/);
  const safeString=v=>typeof v==='string'&&v.trim().length>0&&!/[\r\n]/.test(v);
  if(!response.ok||body?.code!==0||!safeString(d?.access_token)||!safeString(d?.refresh_token)||!(typeof d?.scope==='string'?safeString(d.scope):Array.isArray(d?.scope))||!scopes.length||!scopes.every(safeString)||d.open_id!==grant.TIKTOK_BUSINESS_OPEN_ID||!Number.isFinite(Number(d.expires_in))||Number(d.expires_in)<=0||!Number.isFinite(Number(d.refresh_token_expires_in))||Number(d.refresh_token_expires_in)<=0||!['video.upload','video.publish','video.list'].every(x=>scopes.includes(x)))return {status:'outcome_unknown_no_retry'};
  const values={TIKTOK_BUSINESS_ACCESS_TOKEN:d.access_token,TIKTOK_BUSINESS_REFRESH_TOKEN:d.refresh_token,TIKTOK_BUSINESS_SCOPE:scopes.join(','),TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT:new Date(started+Number(d.expires_in)*1000).toISOString(),TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT:new Date(started+Number(d.refresh_token_expires_in)*1000).toISOString()};
  let next=master.text;for(const [key,value] of Object.entries(values)){let count=0;next=next.replace(new RegExp(`^${key}=.*$`,'gm'),()=>{count++;return `${key}=${value}`;});if(count!==1)return {status:'outcome_unknown_no_retry'};}
  // Canonical first. If mirror write fails the next tick recovers from master.
  await put(VAULTS[0],master,next);await put(VAULTS[1],mirror,next);
  if(!await save(intent,{state:'complete',at:now()}))return {status:'concurrent'};
  return {status:'refreshed'};
 }catch{return {status:'storage_unavailable'};}
}
