import { Hono } from 'hono';
import type { Env } from '../types';
import { INSTAGRAM_ACCOUNT, instagramPermalink, nextEvent, prepareInput, publicSource, sha256, verifiedGraph } from '../lib/ugc-instagram-operation.mjs';

const route = new Hono<{ Bindings: Env }>();
const current = (env: Env, id: string) => env.DB.prepare('SELECT * FROM ugc_instagram_operations WHERE content_id=? AND account=?').bind(id,INSTAGRAM_ACCOUNT).first<Record<string,any>>();
const proofUrl = (job: Record<string,any>) => {
  try { return JSON.parse(job.publications || '[]').find((p: any)=>p.platform==='instagram' && p.verified===true && p.account===INSTAGRAM_ACCOUNT)?.url; }
  catch { return null; }
};

// Mounted only after internal-ugc's constant-time service authentication.
route.get('/reel-jobs/:id/instagram-operation', async c => {
  const operation=await current(c.env,c.req.param('id'));
  const events=operation ? (await c.env.DB.prepare('SELECT sequence,kind,evidence_json,recorded_at FROM ugc_instagram_operation_events WHERE operation_id=? ORDER BY sequence').bind(operation.id).all()).results : [];
  return c.json({ok:true,operation,events});
});

route.post('/reel-jobs/:id/instagram-operation', async c => {
  const id=c.req.param('id');
  const body=await c.req.json().catch(()=>null) as any;
  const input=prepareInput(body);
  if(!input) return c.json({ok:false,error:'valid_instagram_account_caption_file_sha_required'},422);
  const job=await c.env.DB.prepare('SELECT j.status,j.claim_id,j.publications,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?').bind(id).first<Record<string,any>>();
  if(!job) return c.json({ok:false,error:'job_not_found'},404);
  const source=publicSource(job.content_url);
  if(!source) return c.json({ok:false,error:'public_source_required'},422);
  const reconcile=body.mode==='reconcile_existing';
  const oldProof=proofUrl(job);
  if(reconcile ? !oldProof : (job.status!=='working' || !body.claim_id || body.claim_id!==job.claim_id)) return c.json({ok:false,error:reconcile?'existing_verified_instagram_proof_required':'exact_working_claim_required'},409);
  if(!reconcile && oldProof) return c.json({ok:false,error:'already_published_reconcile_existing',url:oldProof},409);
  const captionHash=await sha256(input.caption);
  const key=await sha256(JSON.stringify([id,input.account,input.source_sha256,captionHash]));
  let verification: Record<string,any>|null=null;
  let container: string|null=null;
  if(reconcile) {
    verification=verifiedGraph(body.verification,input);
    container=body.container_id;
    if(!verification || instagramPermalink(oldProof)!==verification.permalink || typeof container!=='string' || !/^[0-9]{5,40}$/.test(container) || body.media_id!==verification.id) return c.json({ok:false,error:'historical_string_ids_and_fresh_matching_graph_proof_required'},422);
  }
  const existing=await current(c.env,id);
  if(existing) {
    if(existing.idempotency_key!==key || (reconcile && (existing.container_id!==container || existing.media_id!==verification!.id || existing.permalink!==verification!.permalink))) return c.json({ok:false,error:'operation_identity_conflict_no_resend',operation:existing},409);
    return c.json({ok:true,created:false,operation:existing});
  }
  const now=new Date().toISOString();
  const operationId=crypto.randomUUID();
  const state=reconcile?'verified':'reserved';
  const evidence=reconcile ? {source:'historical_api_receipts_and_fresh_graph_readback',original_stage_timestamps:null,container_id:container,media_id:verification!.id,verification} : {source:'before_any_external_send',source_sha256:input.source_sha256,caption_sha256:captionHash};
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT OR IGNORE INTO ugc_instagram_operations(id,content_id,account,source_url,source_sha256,caption,caption_sha256,idempotency_key,state,container_id,media_id,permalink,verification_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(operationId,id,input.account,source,input.source_sha256,input.caption,captionHash,key,state,container,verification?.id ?? null,verification?.permalink ?? null,verification?JSON.stringify(verification):null,now,now),
      c.env.DB.prepare(`INSERT INTO ugc_instagram_operation_events(operation_id,sequence,kind,evidence_json,recorded_at) SELECT id,0,?,?,? FROM ugc_instagram_operations WHERE id=?`)
        .bind(reconcile?'reconciled_existing':'reserved',JSON.stringify(evidence),now,operationId),
    ]);
  } catch { return c.json({ok:false,error:'operation_conflict_read_existing_no_resend'},409); }
  const stored=await current(c.env,id);
  if(!stored || stored.idempotency_key!==key) return c.json({ok:false,error:'operation_identity_conflict_no_resend'},409);
  return c.json({ok:true,created:stored.id===operationId,operation:stored});
});

route.post('/reel-jobs/:id/instagram-operation/:operation/event', async c => {
  const operation=await current(c.env,c.req.param('id'));
  if(!operation || operation.id!==c.req.param('operation')) return c.json({ok:false,error:'operation_not_found'},404);
  const body=await c.req.json().catch(()=>null) as any;
  const job=await c.env.DB.prepare('SELECT status,claim_id FROM ugc_reel_jobs WHERE content_id=?').bind(operation.content_id).first<Record<string,any>>();
  const refresh=operation.state==='verified' && body?.kind==='verification_refreshed';
  if(!refresh && (!job || job.status!=='working' || !body?.claim_id || body.claim_id!==job.claim_id)) return c.json({ok:false,error:'exact_working_claim_required'},409);
  const event=nextEvent(operation,body);
  if(!event) return c.json({ok:false,error:'invalid_transition_revision_or_immutable_identity_no_resend'},409);
  const now=new Date().toISOString();
  try {
    const writes=await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE ugc_instagram_operations SET state=?,container_id=?,media_id=?,permalink=?,verification_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state=?`)
        .bind(event.out.state,event.out.container_id,event.out.media_id,event.out.permalink,event.out.verification_json,now,operation.id,operation.revision,operation.state),
      c.env.DB.prepare(`INSERT INTO ugc_instagram_operation_events(operation_id,sequence,kind,evidence_json,recorded_at) SELECT id,revision,?,?,? FROM ugc_instagram_operations WHERE id=? AND revision=? AND updated_at=?`)
        .bind(body.kind,JSON.stringify(event.evidence),now,operation.id,operation.revision+1,now),
    ]);
    if(writes[0].meta.changes!==1) return c.json({ok:false,error:'operation_conflict_read_again_no_resend'},409);
  } catch { return c.json({ok:false,error:'operation_conflict_read_again_no_resend'},409); }
  const stored=await current(c.env,operation.content_id);
  if(!stored || stored.revision!==operation.revision+1) return c.json({ok:false,error:'operation_conflict_read_again_no_resend'},409);
  return c.json({ok:true,operation:stored});
});

export default route;
