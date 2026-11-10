// Owner-authorized API transport, not another native/model work attempt.
// Contract accepted 2026-11-09: TikTok Business Accounts v1.3, owned @dasbroadcast.
// A durable publish_requested precedes the ONLY POST. Unknown outcomes never resend.
import {appendPublicationProofs,reelPublicationProof,reelScope} from './ugc-reel-jobs.mjs';

type Env={DB:any;GITHUB_TOKEN?:string;DIETER_PRIVATE_FILES?:string;ORG_ASSETS?:any};
export type TikTokSource={contentId:string;claimId:string;sourceSha256:string;sourceAssetUrl:string;sourceDurationSeconds:number;sourceAuthor:string;sourceUrl:string;sourceDriveId:string};
export type TikTokResult={status:'preflight_ready'|'pending'|'verified'|'uncertain'|'blocked'|'failed';code?:string;ledgerKey?:string;shareId?:string;proof?:any;account?:string;inventoryComplete?:boolean;inventoryCount?:number;sourceSha256Verified?:boolean;captionPlanVerified?:boolean;diagnostic?:{phase:string;error_class:string}};
type Mode='preflight'|'publish'|'reconcile';
type Options={fetchImpl?:typeof fetch;now?:()=>number};
const APP='7706160588917342228',ACCOUNT='dasbroadcast',BASE='https://business-api.tiktok.com/open_api/v1.3/';
const normalize=(s:string)=>s.replace(/\s+/gu,' ').trim();
const digest=async(s:string|ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof s==='string'?new TextEncoder().encode(s):s))].map(x=>x.toString(16).padStart(2,'0')).join('');
class Stop extends Error{code:string;constructor(code:string){super(code);this.code=code;}}
const stop=(code:string):never=>{throw new Stop(code);};
const id=(value:any)=>typeof value==='string'&&/^\d+$/.test(value);

async function loadGrant(env:Env,fetcher:typeof fetch,now:number){
 if(!env.GITHUB_TOKEN)stop('github_vault_access_missing');
 const r=await fetcher('https://api.github.com/repos/dasexperten/organizacia/contents/SECRETS/company/tiktok-business-publisher.md?ref=secrets',{
  headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'DasExperten-Dieter-TikTok/1.0'},redirect:'manual'});
 if(!r.ok)stop('tiktok_vault_unavailable');
 let card;try{const j:any=await r.json();card=atob(j.content.replace(/\s/g,''));}catch{stop('tiktok_vault_invalid');}
 const grant=Object.fromEntries([...card.matchAll(/^([A-Z_]+)=(.+)$/gm)].map(x=>[x[1],x[2].trim()]));
 if(grant.TIKTOK_BUSINESS_APP_ID!==APP||grant.TIKTOK_BUSINESS_USERNAME!==ACCOUNT||!grant.TIKTOK_BUSINESS_ACCESS_TOKEN||!grant.TIKTOK_BUSINESS_OPEN_ID)stop('tiktok_grant_identity_invalid');
 const scopes=new Set(grant.TIKTOK_BUSINESS_SCOPE?.split(/[,\s]+/));
 if(!['video.upload','video.publish','video.list'].every(s=>scopes.has(s)))stop('tiktok_grant_scope_missing');
 const expires=Date.parse(grant.TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT);
 if(!Number.isFinite(expires)||expires<=now)stop('tiktok_grant_expired');
 return {token:grant.TIKTOK_BUSINESS_ACCESS_TOKEN,businessId:grant.TIKTOK_BUSINESS_OPEN_ID};
}

function client(grant:{token:string;businessId:string},fetcher:typeof fetch){
 return async(path:string,params:Record<string,any>={},post=false)=>{
  const url=new URL(BASE+path+'/');
  const body={business_id:grant.businessId,...params};
  if(!post)for(const [key,value]of Object.entries(body))url.searchParams.set(key,String(value));
  let r:Response,j:any;
  try{r=await fetcher(url.toString(),{method:post?'POST':'GET',headers:{'Access-Token':grant.token,'Content-Type':'application/json','User-Agent':'DasExperten-Dieter-TikTok/1.0'},...(post?{body:JSON.stringify(body)}:{}),redirect:'manual'});}
  catch{stop(post?'tiktok_publish_outcome_unknown':'tiktok_read_unavailable');}
  try{j=await r.json();}catch{stop(post?'tiktok_publish_outcome_unknown':'tiktok_read_invalid');}
  // Never expose provider bodies, request URLs, credentials or raw exception text.
  if(!r.ok||j?.code!==0)stop(post?'tiktok_publish_rejected_or_unknown':'tiktok_read_rejected');
  if(!j.data||typeof j.data!=='object')stop(post?'tiktok_publish_outcome_unknown':'tiktok_read_invalid');
  return j.data;
 };
}

// Restore the canonical verified public hosting path from the exact Drive
// original. This hosts identical bytes; it never edits or submits to TikTok.
export async function ensureDieterTikTokSourceAsset(env:Env,args:TikTokSource,fetcher:typeof fetch=fetch){
 const expected=`https://org.dasexperten.com/assets/ugc/${args.sourceSha256}/original.mp4`;
 if(args.sourceAssetUrl!==expected||!/^[a-f0-9]{64}$/.test(args.sourceSha256))stop('tiktok_original_asset_invalid');
 const publicRead=async()=>{
  let r:Response;try{r=await fetcher(expected,{redirect:'manual'});}catch{stop('tiktok_original_asset_unavailable');}
  if(r.status===404)return false;
  if(!r.ok)stop('tiktok_original_asset_unavailable');
  const mime=(r.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
  if(!mime.startsWith('video/')&&mime!=='application/octet-stream')stop('tiktok_original_media_type_unconfirmed');
  if(await digest(await r.arrayBuffer())!==args.sourceSha256)stop('tiktok_original_sha256_mismatch');
  return true;
 };
 if(await publicRead())return {sourceSha256Verified:true,sourceHosted:false};
 if(!env.ORG_ASSETS||!env.DIETER_PRIVATE_FILES)stop('tiktok_original_hosting_unavailable');
 let c:any;try{const files=JSON.parse(env.DIETER_PRIVATE_FILES);c=files['google-drive-api.json'];if(typeof c==='string')c=JSON.parse(c);}catch{stop('tiktok_drive_credentials_invalid');}
 if(!c?.client_id||!c.client_secret||!c.refresh_token||!args.sourceDriveId)stop('tiktok_drive_credentials_missing');
 const refreshed=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,refresh_token:c.refresh_token,grant_type:'refresh_token'}),redirect:'manual'});
 if(!refreshed.ok)stop('tiktok_drive_refresh_failed');
 const token:any=await refreshed.json();if(typeof token.access_token!=='string'||!token.access_token)stop('tiktok_drive_refresh_invalid');
 const original=await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.sourceDriveId)}?alt=media`,{headers:{Authorization:`Bearer ${token.access_token}`},redirect:'manual'});
 if(!original.ok)stop('tiktok_drive_original_unavailable');
 const bytes=await original.arrayBuffer();if(await digest(bytes)!==args.sourceSha256)stop('tiktok_original_sha256_mismatch');
 await env.ORG_ASSETS.put(`org/assets/ugc/${args.sourceSha256}/original.mp4`,bytes,{httpMetadata:{contentType:'video/mp4'},customMetadata:{source_sha256:args.sourceSha256}});
 if(!await publicRead())stop('tiktok_original_hosting_readback_failed');
 return {sourceSha256Verified:true,sourceHosted:true};
}

async function inventory(api:ReturnType<typeof client>){
 const videos:any[]=[],cursors=new Set<string>();let cursor:string|undefined;
 do{
  const page=await api('business/video/list',{fields:JSON.stringify(['item_id','caption','create_time','share_url','video_duration']),max_count:20,...(cursor?{cursor}:{})});
  if(!Array.isArray(page.videos)||typeof page.has_more!=='boolean'||page.videos.some((v:any)=>!id(v.item_id)||typeof v.caption!=='string'))stop('tiktok_inventory_incomplete');
  videos.push(...page.videos);
  if(!page.has_more)return videos;
  if(!['string','number'].includes(typeof page.cursor)||String(page.cursor)===''||cursors.has(String(page.cursor)))stop('tiktok_inventory_cursor_invalid');
  cursors.add(String(page.cursor));cursor=String(page.cursor);
 }while(true);
}

async function saveProof(env:Env,args:TikTokSource,proof:any){
 const row:any=await env.DB.prepare('SELECT status,claim_id,publications FROM ugc_reel_jobs WHERE content_id=?').bind(args.contentId).first();
 if(!row||row.status!=='working'||row.claim_id!==args.claimId)stop('tiktok_working_claim_changed');
 let existing;try{existing=JSON.parse(row.publications);if(!Array.isArray(existing))throw Error();}catch{stop('tiktok_existing_proofs_invalid');}
 const checked=reelPublicationProof([proof],args.sourceUrl);if(!checked)stop('tiktok_provider_proof_invalid');
 if(existing.some((p:any)=>p.platform==='tiktok'&&p.url!==proof.url))stop('tiktok_existing_proof_conflict');
 const merged=appendPublicationProofs(existing,checked);
 if(merged.length===existing.length)return;
 const r=await env.DB.prepare("UPDATE ugc_reel_jobs SET publications=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=? AND publications=?")
  .bind(JSON.stringify(merged),new Date().toISOString(),args.contentId,args.claimId,row.publications).run();
 if(!r.meta.changes)stop('tiktok_proof_cas_conflict_read_only_resume');
 const after:any=await env.DB.prepare('SELECT publications FROM ugc_reel_jobs WHERE content_id=?').bind(args.contentId).first();
 if(!JSON.parse(after?.publications??'[]').some((p:any)=>p.platform==='tiktok'&&p.url===proof.url))stop('tiktok_proof_readback_failed');
}

export async function runDieterTikTokApi(env:Env,args:TikTokSource,mode:Mode,options:Options={}):Promise<TikTokResult>{
 const fetcher=options.fetchImpl??fetch,now=options.now??Date.now;
 let ledgerKey:string|undefined,phase='input_validation';
 try{
  if(!['preflight','publish','reconcile'].includes(mode))stop('tiktok_mode_invalid');
  if(!args.contentId||!args.claimId||!/^[a-f0-9]{64}$/.test(args.sourceSha256)||!args.sourceAuthor||!args.sourceDriveId||!Number.isFinite(args.sourceDurationSeconds)||args.sourceDurationSeconds<=0)stop('tiktok_source_identity_invalid');
  let asset:URL;try{asset=new URL(args.sourceAssetUrl);}catch{stop('tiktok_original_asset_invalid');}
  if(asset.protocol!=='https:'||asset.hostname!=='org.dasexperten.com'||!asset.pathname.startsWith('/assets/ugc/')||asset.search||asset.hash||asset.username||asset.password)stop('tiktok_original_asset_invalid');
  phase='assignment_read';
  const job:any=await env.DB.prepare('SELECT status,claim_id,required_destinations,publications FROM ugc_reel_jobs WHERE content_id=?').bind(args.contentId).first();
  if(!job||job.status!=='working'||job.claim_id!==args.claimId||!reelScope(job).active.includes('tiktok'))stop('tiktok_exact_working_claim_required');
  phase='caption_plan_read';
  const planRow:any=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-caption-plan:${args.contentId}:${args.claimId}`).first();
  let plan;try{plan=JSON.parse(planRow?.value??'null');}catch{stop('tiktok_caption_plan_invalid');}
  const caption=plan?.platforms?.tiktok?.caption;
  if(plan?.content_id!==args.contentId||typeof caption!=='string'||!caption.trim()||!caption.toLocaleLowerCase().includes(args.sourceAuthor.replace(/^@/,'').toLocaleLowerCase()))stop('tiktok_saved_caption_plan_required');
  phase='identity_hash';
  const identity={contentId:args.contentId,claimId:args.claimId,sourceSha256:args.sourceSha256,sourceDriveId:args.sourceDriveId,sourceAuthor:args.sourceAuthor,sourceUrl:args.sourceUrl,sourceAssetUrl:args.sourceAssetUrl,captionSha256:await digest(caption)};
  ledgerKey=`ugc-tiktok-business:${args.contentId}:${args.sourceSha256}`;
  const read=async()=>await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(ledgerKey).first();
  const cas=async(before:string,value:any,requireWorkingClaim=false)=>{
   const next=JSON.stringify(value),params:any[]=[next,now(),ledgerKey,before];
   const guard=requireWorkingClaim?" AND EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND status='working' AND claim_id=?) AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked'))":'';
   if(requireWorkingClaim)params.push(args.contentId,args.claimId);
   const r=await env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?'+guard).bind(...params).run();
   return r.meta.changes?next:null;
  };
  phase='ledger_read';
  let stored:any=await read(),ledger:any=stored?JSON.parse(stored.value):null;
  if(ledger&&JSON.stringify(ledger.identity)!==JSON.stringify(identity))stop('tiktok_immutable_source_or_caption_conflict');
  if(ledger?.state==='failed')return {status:'failed',code:'tiktok_provider_failed_no_resend',ledgerKey};
  if(ledger&&['publish_requested','uncertain'].includes(ledger.state))return {status:'uncertain',code:'tiktok_no_resend_without_saved_share_id',ledgerKey};
  phase='grant_read';
  const grant=await loadGrant(env,fetcher,now()),api=client(grant,fetcher);
  phase='account_read';
  const account=await api('business/get',{fields:JSON.stringify(['username','display_name'])});
  if(account.username!==ACCOUNT)stop('tiktok_live_account_mismatch');
  if(!ledger||ledger.state==='reserved'){
   const existing=JSON.parse(job.publications??'[]');if(existing.some((p:any)=>p.platform==='tiktok'))return {status:'blocked',code:'tiktok_existing_proof_reconcile_only'};
   phase='settings_read';
   const settings=await api('business/video/settings');
   if(!Array.isArray(settings.privacy_level_options)||!settings.privacy_level_options.includes('PUBLIC_TO_EVERYONE')||!Number.isFinite(settings.max_video_post_duration_sec)||args.sourceDurationSeconds>settings.max_video_post_duration_sec||!['comment_disabled','duet_disabled','stitch_disabled'].every(k=>typeof settings[k]==='boolean'))stop('tiktok_live_post_settings_unavailable');
   phase='inventory_read';
   const videos=await inventory(api),references=[args.sourceUrl,args.sourceAuthor.replace(/^@/,'')].map(s=>s.toLocaleLowerCase());
   if(videos.some(v=>normalize(v.caption)===normalize(caption)||references.some(ref=>ref&&v.caption.toLocaleLowerCase().includes(ref))))return {status:'blocked',code:'tiktok_existing_source_candidate_readback_required',inventoryCount:videos.length};
   if(mode==='reconcile')return {status:'blocked',code:'tiktok_no_saved_publication_intent'};
   phase='source_prepare';
   await ensureDieterTikTokSourceAsset(env,args,fetcher);
   if(mode==='preflight')return {status:'preflight_ready',account:ACCOUNT,inventoryComplete:true,inventoryCount:videos.length,sourceSha256Verified:true,captionPlanVerified:true};
   phase='ledger_reserve';
   const value={version:'tiktok-business-v1',identity,state:'reserved',reservedAt:now()};
   await env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND status='working' AND claim_id=?) ON CONFLICT(key) DO NOTHING")
    .bind(ledgerKey,JSON.stringify(value),now(),args.contentId,args.claimId).run();
   stored=await read();if(!stored)stop('tiktok_working_claim_changed');ledger=JSON.parse(stored.value);
   if(JSON.stringify(ledger.identity)!==JSON.stringify(identity))stop('tiktok_immutable_source_or_caption_conflict');
   // The reservation winner alone can cross the external side-effect boundary.
   phase='provider_intent';
   const requested={...ledger,state:'publish_requested',publishRequestedAt:now()};
   const requestedRaw=ledger.state==='reserved'?await cas(stored.value,requested,true):null;
   if(!requestedRaw)return {status:'pending',code:'tiktok_concurrent_or_existing_intent_readback_only',ledgerKey};
   const post_info={caption,is_brand_organic:true,is_branded_content:false,disable_comment:settings.comment_disabled,disable_duet:settings.duet_disabled,disable_stitch:settings.stitch_disabled,is_ai_generated:false,upload_to_draft:false,is_ads_only:false};
   phase='provider_publish';
   let published:any;
   try{published=await api('business/video/publish',{video_url:args.sourceAssetUrl,post_info},true);}
   catch{await cas(requestedRaw,{...requested,state:'uncertain',code:'tiktok_publish_outcome_unknown'});return {status:'uncertain',code:'tiktok_publish_outcome_unknown_no_resend',ledgerKey};}
   if(typeof published.share_id!=='string'||!published.share_id){await cas(requestedRaw,{...requested,state:'uncertain',code:'tiktok_share_id_missing'});return {status:'uncertain',code:'tiktok_share_id_missing_no_resend',ledgerKey};}
   ledger={...requested,state:'accepted',shareId:published.share_id,acceptedAt:now()};
   const acceptedRaw=await cas(requestedRaw,ledger);if(!acceptedRaw)return {status:'uncertain',code:'tiktok_share_id_persistence_conflict_no_resend',ledgerKey};
   stored={value:acceptedRaw};
  }
  if(mode==='preflight')return {status:'pending',code:'tiktok_existing_intent_reconcile_only',ledgerKey};
  if(ledger.state==='verified'){phase='proof_save';await saveProof(env,args,ledger.proof);return {status:'verified',ledgerKey,proof:ledger.proof};}
  if(ledger.state!=='accepted'||!ledger.shareId)return {status:'uncertain',code:'tiktok_no_resend_without_saved_share_id',ledgerKey};
  phase='provider_status';
  const status=await api('business/publish/status',{publish_id:ledger.shareId});
  if(status.status==='FAILED'){await cas(stored.value,{...ledger,state:'failed'});return {status:'failed',code:'tiktok_provider_failed_no_resend',ledgerKey};}
  if(status.status!=='PUBLISH_COMPLETE'||!Array.isArray(status.post_ids)||!status.post_ids.length)return {status:'pending',ledgerKey,shareId:ledger.shareId};
  if(status.post_ids.length!==1||!id(status.post_ids[0]))stop('tiktok_unexpected_post_ids');
  phase='provider_post_readback';
  const postId=status.post_ids[0],videos=await inventory(api),matches=videos.filter(v=>v.item_id===postId);
  if(matches.length!==1||normalize(matches[0].caption)!==normalize(caption))stop('tiktok_exact_post_or_caption_readback_failed');
  // Match the existing Facebook helper's accepted container/audio duration
  // window; comparing the actual post catches truncated provider deliveries.
  const duration=matches[0].video_duration;
  if(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||Math.abs(duration-args.sourceDurationSeconds)>1.5)stop('tiktok_original_duration_readback_mismatch');
  let publicUrl:URL;try{publicUrl=new URL(matches[0].share_url);}catch{stop('tiktok_public_share_url_missing');}
  if(publicUrl.protocol!=='https:'||!['www.tiktok.com','tiktok.com'].includes(publicUrl.hostname)||publicUrl.pathname!==`/@${ACCOUNT}/video/${postId}`||publicUrl.username||publicUrl.password)stop('tiktok_public_share_url_mismatch');
  publicUrl.search='';publicUrl.hash='';
  const proof={platform:'tiktok',url:publicUrl.toString(),account:ACCOUNT,verified:true,evidence:`TikTok Business API PUBLISH_COMPLETE with one exact post ID; complete video/list confirms account, caption and provider share URL; returned duration ${duration}s vs original ${args.sourceDurationSeconds}s; original SHA256 ${args.sourceSha256}`,verified_at:new Date(now()).toISOString(),provider_video_id:postId,verification_method:'tiktok_business_api',source_sha256:args.sourceSha256,video_duration:duration};
  // Persist provider IDs/proof before ERP's proof CAS, so a crash resumes GET-only.
  const verified={...ledger,state:'verified',postIds:[postId],proof,verifiedAt:now()};
  if(!await cas(stored.value,verified))stop('tiktok_verified_ledger_conflict_read_only_resume');
  phase='proof_save';
  await saveProof(env,args,proof);
  return {status:'verified',ledgerKey,proof};
 }catch(error){
  const error_class=error instanceof Stop?'controlled':error instanceof TypeError?'type_error':error instanceof SyntaxError?'syntax_error':error instanceof RangeError?'range_error':error instanceof Error?'error':'unknown';
  return {status:'blocked',code:error instanceof Stop?error.code:'tiktok_transport_failed_closed',diagnostic:{phase,error_class},...(ledgerKey?{ledgerKey}:{})};
 }
}
