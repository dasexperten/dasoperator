// Owner 10.11.2026: successful provider acceptance completes the upload,
// independently of moderation/public availability. Never manufacture a proof.
import {reelScope,reelPublicationProof} from './ugc-reel-jobs.mjs';
type Env={DB:any};
export async function finishDieterUploads(env:Env,contentId:string,claimId:string){
 const row=await env.DB.prepare('SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(contentId).first();
 if(!row||row.claim_id!==claimId)throw Error('upload_exact_claim_required');
 const required=reelScope(row).active;
 const proofs=reelPublicationProof(JSON.parse(row.publications??'[]'),row.content_url)??[];
 const accepted:any[]=proofs.map((p:any)=>({platform:p.platform,status:'publicly_verified',provider_id:p.url,accepted_at:p.verified_at,url:p.url}));
 const read=async(key:string)=>{const r=await env.DB.prepare('SELECT value,updated_at FROM crm_sync_state WHERE key=?').bind(key).first();return r?{value:JSON.parse(r.value),at:new Date(r.updated_at).toISOString()}:null;};
 for(const platform of required.filter((p:string)=>!accepted.some(a=>a.platform===p))){
  if(platform==='tiktok'){
   const result=await env.DB.prepare("SELECT value,updated_at FROM crm_sync_state WHERE substr(key,1,length(?))=? AND json_valid(value) AND json_extract(value,'$.identity.claimId')=?").bind('ugc-tiktok-business:'+contentId+':','ugc-tiktok-business:'+contentId+':',claimId).all();
   for(const r of result.results??[]){const v=JSON.parse(r.value);if(v.identity?.contentId===contentId&&v.identity?.sourceUrl===row.content_url&&/^[a-f0-9]{64}$/.test(v.identity?.sourceSha256??'')&&['accepted','verified'].includes(v.state)&&typeof v.shareId==='string'&&v.shareId&&Number.isFinite(v.acceptedAt))accepted.push({platform,status:'accepted_processing',provider_id:v.shareId,accepted_at:new Date(v.acceptedAt).toISOString(),source_sha256:v.identity.sourceSha256});}
  }else if(platform==='rutube'){
   const r=await read(`ugc-rutube-pending:${contentId}:${claimId}`),v=r?.value;
   if(v&&/^[a-f0-9]{32}$/.test(v.video_id)&&/^[a-f0-9]{64}$/.test(v.source_sha256))accepted.push({platform,status:'accepted_processing',provider_id:v.video_id,accepted_at:r.at,source_sha256:v.source_sha256});
  }else{
   const r=await read(`ugc-upload-accepted:${contentId}:${claimId}:${platform}`),v=r?.value;
   if(v?.provider_accepted===true&&v.claim_id===claimId&&v.content_id===contentId&&v.platform===platform&&typeof v.provider_id==='string'&&v.provider_id.trim()&&/^[a-f0-9]{64}$/.test(v.source_sha256??''))accepted.push({platform,status:'accepted_processing',provider_id:v.provider_id,accepted_at:r.at,source_sha256:v.source_sha256});
  }
 }
 const missing=required.filter((p:string)=>!accepted.some(a=>a.platform===p));
 const publicMissing=required.filter((p:string)=>!proofs.some((a:any)=>a.platform===p));
 if(missing.length)return {upload_completed:false,publication_verified:false,missing,accepted};
 const publicVerified=publicMissing.length===0,status=publicVerified?'published':'uploaded';
 if(!['working','uploaded','published'].includes(row.status))throw Error('upload_job_not_active');
 const receipt={version:1,content_id:contentId,claim_id:claimId,upload_completed:true,publication_verified:publicVerified,status,accepted,public_pending:publicMissing,completed_at:new Date(Math.max(...accepted.map(a=>Date.parse(a.accepted_at)))).toISOString(),recorded_at:new Date().toISOString()};
 const key=`dieter_upload_completion:${contentId}:${claimId}`;
 // Atomic terminal state + receipt: the queue sees no intermediate fake proof.
 await env.DB.batch([
  env.DB.prepare("INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND claim_id=? AND publications=? AND status IN ('working','uploaded','published')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key,JSON.stringify(receipt),Date.now(),contentId,claimId,row.publications),
  env.DB.prepare("UPDATE ugc_reel_jobs SET status=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END,last_error=NULL,updated_at=? WHERE content_id=? AND claim_id=? AND publications=? AND status IN ('working','uploaded','published')").bind(status,status,new Date().toISOString(),new Date().toISOString(),contentId,claimId,row.publications),
 ]);
 const after=await env.DB.prepare('SELECT status,publications FROM ugc_reel_jobs WHERE content_id=? AND claim_id=?').bind(contentId,claimId).first();
 if(after?.status!==status||after.publications!==row.publications)throw Error('upload_completion_cas_conflict');
 return receipt;
}
