// Reconcile only the provider ID already accepted for this exact claim.
// No authentication, upload, replacement video, model call or submission retry.
import {appendPublicationProofs,reelPublicationProof} from './ugc-reel-jobs.mjs';
type Env={DB:any};
type Args={contentId:string;claimId:string};
type Options={fetchImpl?:typeof fetch;now?:()=>number};
type Result={status:'verified'|'pending'|'blocked';code?:string;proof?:any;videoId?:string;alreadyPresent?:boolean};
const AUTHOR=59945486;

export async function reconcileDieterRutubeStatus(env:Env,args:Args,options:Options={}):Promise<Result>{
 const fetcher=options.fetchImpl??fetch,now=options.now??Date.now;
 try{
  const job:any=await env.DB.prepare('SELECT j.status,j.claim_id,j.publications,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(args.contentId).first();
  if(!job||job.status!=='working'||job.claim_id!==args.claimId)return {status:'blocked',code:'rutube_exact_working_claim_required'};
  let existing:any[];try{existing=JSON.parse(job.publications);if(!Array.isArray(existing))throw Error();}catch{return {status:'blocked',code:'rutube_existing_proofs_invalid'};}
  const prior=existing.find(p=>p.platform==='rutube');
  if(prior){
   const checked=reelPublicationProof([prior],job.content_url);
   return checked?{status:'verified',proof:prior,alreadyPresent:true}:{status:'blocked',code:'rutube_existing_proof_unverified'};
  }
  const saved:any=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-rutube-pending:${args.contentId}:${args.claimId}`).first();
  let pending:any;try{pending=JSON.parse(saved?.value??'null');}catch{return {status:'blocked',code:'rutube_pending_receipt_invalid'};}
  if(!pending||!/^[a-f0-9]{32}$/.test(pending.video_id)||!/^[a-f0-9]{64}$/.test(pending.source_sha256)||typeof pending.duration_seconds!=='number'||!Number.isFinite(pending.duration_seconds)||pending.duration_seconds<=0)return {status:'blocked',code:'rutube_exact_pending_id_and_source_required'};
  const videoId=pending.video_id;
  const planRow:any=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-caption-plan:${args.contentId}:${args.claimId}`).first();
  let plan:any;try{plan=JSON.parse(planRow?.value??'null');}catch{return {status:'blocked',code:'rutube_saved_caption_plan_invalid',videoId};}
  const caption=plan?.platforms?.rutube?.caption;
  if(plan?.content_id!==args.contentId||typeof caption!=='string'||!caption.trim())return {status:'blocked',code:'rutube_saved_caption_plan_required',videoId};
  const read=async(path:string)=>{
   try{const r=await fetcher(`https://rutube.ru/api/${path}/${videoId}/`,{method:'GET',headers:{Accept:'application/json','User-Agent':'Mozilla/5.0'},redirect:'error'});if(!r.ok)return null;return await r.json();}catch{return null;}
  };
  const video:any=await read('video');
  if(!video)return {status:'pending',code:'rutube_public_record_not_ready',videoId};
  if(video.id!==videoId||video.author?.id!==AUTHOR)return {status:'blocked',code:'rutube_public_identity_mismatch',videoId};
  // An accepted ID under ingestion/moderation can temporarily report deleted.
  // Retain it and wait; that is never permission to upload another copy.
  if(video.is_deleted!==false||video.is_hidden!==false)return {status:'pending',code:'rutube_processing_or_moderation',videoId};
  if(video.description!==caption)return {status:'blocked',code:'rutube_saved_caption_mismatch',videoId};
  if(typeof video.duration!=='number'||!Number.isFinite(video.duration)||video.duration<=0||Math.abs(video.duration-pending.duration_seconds)>1.5)return {status:'blocked',code:'rutube_original_duration_not_confirmed',videoId};
  const playback:any=await read('play/options');
  if(!playback)return {status:'pending',code:'rutube_playback_not_ready',videoId};
  if((playback.video_id??playback.id)!==videoId||playback.author?.id!==AUTHOR)return {status:'blocked',code:'rutube_playback_identity_mismatch',videoId};
  const balancer=playback.video_balancer;
  if(playback.is_hidden!==false||playback.has_video!==true||playback.acl_access?.allowed!==true||!balancer||typeof balancer!=='object'||!Object.values(balancer).some(v=>typeof v==='string'&&/^https?:\/\//.test(v)))return {status:'pending',code:'rutube_processing_or_moderation',videoId};
  // Regular video duration is seconds; play/options uses milliseconds.
  if(typeof playback.duration!=='number'||!Number.isFinite(playback.duration)||playback.duration<=0||Math.abs(playback.duration/1000-pending.duration_seconds)>1.5)return {status:'blocked',code:'rutube_playback_full_duration_not_confirmed',videoId};
  const proof={platform:'rutube',url:`https://rutube.ru/video/${videoId}/`,account:String(AUTHOR),verified:true,verified_at:new Date(now()).toISOString(),source_sha256:pending.source_sha256,evidence:`Anonymous Rutube API: exact accepted ID and channel ${AUTHOR}, exact saved caption, public nondeleted/nonhidden video ${video.duration}s; playback ACL allowed, has_video and processed streams present, playback ${playback.duration/1000}s vs original ${pending.duration_seconds}s.`};
  const checked=reelPublicationProof([proof],job.content_url);if(!checked)return {status:'blocked',code:'rutube_public_proof_invalid',videoId};
  const merged=appendPublicationProofs(existing,checked);
  const result=await env.DB.prepare("UPDATE ugc_reel_jobs SET publications=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=? AND publications=?")
   .bind(JSON.stringify(merged),new Date(now()).toISOString(),args.contentId,args.claimId,job.publications).run();
  if(!result.meta.changes)return {status:'pending',code:'rutube_proof_cas_conflict_read_again',videoId};
  const after:any=await env.DB.prepare('SELECT publications FROM ugc_reel_jobs WHERE content_id=?').bind(args.contentId).first();
  if(!JSON.parse(after?.publications??'[]').some((p:any)=>p.platform==='rutube'&&p.url===proof.url&&p.verified===true))return {status:'pending',code:'rutube_proof_readback_unconfirmed',videoId};
  return {status:'verified',proof,videoId};
 }catch{return {status:'blocked',code:'rutube_status_read_failed_closed'};}
}
