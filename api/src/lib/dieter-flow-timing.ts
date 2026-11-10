import type {Env} from '../types';
import {reelScope,reelPublicationProof} from './ugc-reel-jobs.mjs';

export function dieterFlowTiming(row:any,continuation:any=null){
 const start=continuation?.at??row.started_at,end=row.published_at;
 const startMs=Date.parse(start),endMs=Date.parse(end);
 const proofs=reelPublicationProof(JSON.parse(row.publications??'[]'),row.content_url);
 const required=reelScope(row).active;
 if(row.status!=='published'||!required.length||!proofs||!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<startMs||required.some((platform:string)=>!proofs.some(p=>p.platform===platform)))return null;
 return {version:1,content_id:row.content_id,claim_id:row.claim_id,
  started_at:start,completed_at:end,elapsed_ms:endMs-startMs,
  start_basis:continuation?'controlled_cloud_continuation':'cloud_claim_accepted',
  end_basis:'all_required_publications_verified_and_saved',
  attempts:row.attempts,clean_run:continuation?false:null,
  benchmark_class:continuation?'repair_run':'automatic_flow_requires_incident_review',
  queue_wait_ms:Number.isFinite(Date.parse(row.requested_at))?Math.max(0,startMs-Date.parse(row.requested_at)):null,
  required_destinations:required,platforms:required.map((platform:string)=>{
   const proof=proofs.find(p=>p.platform===platform)!;
   return {platform,verified_at:proof.verified_at,elapsed_ms:Math.max(0,Date.parse(proof.verified_at)-startMs),url:proof.url};
  }),...(continuation?{continuation_id:continuation.continuation_id,includes_repair_gaps:true}:{}),
  timing_scope:'wall_clock_including_processing_and_recovery; source_download_only_if_performed_in_this_run'};
}
export async function saveDieterFlowTiming(env:Env,contentId:string,claimId:string){
 const row=await env.DB.prepare('SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(contentId).first<any>();
 if(!row||row.claim_id!==claimId)return null;
 if(row.status==='uploaded'){const receipt=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`dieter_upload_completion:${contentId}:${claimId}`).first<{value:string}>();if(!receipt)return null;const done=JSON.parse(receipt.value);return {...done,started_at:row.started_at,elapsed_ms:Math.max(0,Date.parse(done.completed_at)-Date.parse(row.started_at)),end_basis:'all_required_uploads_accepted',clean_run:null,benchmark_class:'upload_completion_requires_incident_review'};}
 const ordinal=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind('dieter_cloud_work_ordinal:'+contentId+':3').first<{value:string}>();
 let continuation:any=null;
 if(ordinal){
  const candidate=JSON.parse(ordinal.value);
  const definition=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind('dieter_cloud_continuation:'+candidate.continuation_id).first<{value:string}>();
  if(definition&&JSON.parse(definition.value).claim_id===claimId)continuation=candidate;
 }
 const timing=dieterFlowTiming(row,continuation);if(!timing)return null;
 await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
  .bind(`dieter_cloud_flow_timing:${contentId}:${claimId}`,JSON.stringify(timing),Date.now()).run();
 const saved=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`dieter_cloud_flow_timing:${contentId}:${claimId}`).first<{value:string}>();
 return saved?JSON.parse(saved.value):null;
}
