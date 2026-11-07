export const INSTAGRAM_ACCOUNT = 'dasexperten';
const ID = /^[0-9]{5,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const TRANSITIONS = {
  reserved: ['container_requested'],
  container_requested: ['container_created'],
  container_created: ['processing','publish_requested'],
  processing: ['processing','publish_requested'],
  publish_requested: ['published'],
  published: ['verified'],
  verified: ['verification_refreshed'],
};
export function publicSource(value) {
  try {
    const url = new URL(value);
    if(url.protocol!=='https:' || url.username || url.password) return null;
    const video = /(^|\.)youtube\.com$/.test(url.hostname) ? url.searchParams.get('v') : null;
    url.search=''; url.hash='';
    if(video && /^[A-Za-z0-9_-]{11}$/.test(video)) url.searchParams.set('v',video);
    return url.href;
  } catch { return null; }
}
export function instagramPermalink(value) {
  try {
    const url = new URL(value);
    if(url.protocol!=='https:' || !['instagram.com','www.instagram.com'].includes(url.hostname) || !/^\/(reel|p)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) return null;
    return `https://www.instagram.com${url.pathname.replace(/\/$/,'')}/`;
  } catch { return null; }
}
export function noCredentials(value) {
  const text = JSON.stringify(value);
  return !/(?:EAA[A-Za-z0-9]{30,}|Bearer\s+[A-Za-z0-9._-]+|access_token|client_secret|EMAILER_SERVICE_SECRET|X-Emailer-Service-Secret)/i.test(text);
}
export async function sha256(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function prepareInput(body) {
  if(!body || body.account!==INSTAGRAM_ACCOUNT || typeof body.caption!=='string' || !body.caption.trim() || body.caption.length>2200 || !HASH.test(body.source_sha256 ?? '') || !noCredentials(body)) return null;
  return {account:INSTAGRAM_ACCOUNT,caption:body.caption,source_sha256:body.source_sha256};
}
export function verifiedGraph(value, operation) {
  if(!value || typeof value.id!=='string' || !ID.test(value.id) || value.username!==INSTAGRAM_ACCOUNT || value.caption!==operation.caption || value.media_type!=='VIDEO' || value.media_product_type!=='REELS' || !instagramPermalink(value.permalink) || !Number.isFinite(Date.parse(value.checked_at ?? '')) || !noCredentials(value)) return null;
  return {id:value.id,username:value.username,caption:value.caption,media_type:value.media_type,media_product_type:value.media_product_type,permalink:instagramPermalink(value.permalink),checked_at:value.checked_at};
}
export function nextEvent(operation,body) {
  if(!body || !Number.isSafeInteger(body.expected_revision) || body.expected_revision!==operation.revision || !noCredentials(body)) return null;
  const kind=body.kind;
  if(!TRANSITIONS[operation.state]?.includes(kind) && !(['uncertain','failed'].includes(kind) && !['verified','uncertain','failed'].includes(operation.state))) return null;
  const out={state:kind==='verification_refreshed'?'verified':kind,container_id:operation.container_id,media_id:operation.media_id,permalink:operation.permalink,verification_json:operation.verification_json};
  for(const name of ['container_id','media_id']) {
    if(body[name]!==undefined) {
      if(typeof body[name]!=='string' || !ID.test(body[name]) || (operation[name] && operation[name]!==body[name])) return null;
      out[name]=body[name];
    }
  }
  if(kind==='container_created' && !out.container_id) return null;
  if(['processing','publish_requested'].includes(kind) && !out.container_id) return null;
  if(kind==='published' && (!out.container_id || !out.media_id)) return null;
  if(['verified','verification_refreshed'].includes(kind)) {
    const verification=verifiedGraph(body.verification,operation);
    if(!verification || verification.id!==out.media_id) return null;
    if(operation.permalink && instagramPermalink(operation.permalink)!==verification.permalink) return null;
    out.permalink=verification.permalink;
    out.verification_json=JSON.stringify(verification);
  }
  const evidence={kind,container_id:out.container_id,media_id:out.media_id,permalink:out.permalink};
  if(out.verification_json) evidence.verification=JSON.parse(out.verification_json);
  if(['failed','uncertain'].includes(kind)) {
    if(typeof body.error_code!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.error_code)) return null;
    evidence.error_code=body.error_code;
  }
  return {out,evidence};
}
