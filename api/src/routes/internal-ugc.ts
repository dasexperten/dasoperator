import {writeAlexandraHeadline} from '../lib/alexandra-headline.mjs';
import {finishDieterUploads} from '../lib/dieter-upload-completion';
// Owner 2026-10-17: a tap on a Diana hard-question button in Telegram arrives here
// from the organizacia bot (service binding EMAILER, same service secret as mail).
import { Hono } from 'hono';
import { ALARM, freshSignal, alarmWireName, MOSCOW_SCHEDULE } from '../lib/diter-ugc-alarm.mjs';
import { reelPublicationProof, appendPublicationProofs, reelTaskText, reelScope, reelJobScopeView, REEL_SCOPE_VERSION, type ReelPublication } from '../lib/ugc-reel-jobs.mjs';
import { tickDiterAlarm, reelAssignment, CONSUMER_TTL_MS, acceptLegacyReel } from '../lib/ugc-reel-store';
import type { Env } from '../types';
import { answerHardQuestion } from '../lib/ugc-hard-question';
import instagramOperationRoutes from './internal-ugc-instagram';
import {scheduleDieterTikTokTransport,awaitsDieterApiCompletion} from '../dieter-tiktok-workflow';
import {runDieterTikTokApi} from '../lib/dieter-tiktok';
import {saveDieterFlowTiming} from '../lib/dieter-flow-timing';

const route = new Hono<{ Bindings: Env }>();
// Fixed read-only self-test. It receives no creator content and cannot send a DM.
route.post('/direct-subscription-check', async c => {
  const expected=c.env.CODEX_ROUTE_SECRET ?? '';
  const given=c.req.header('X-Codex-Route-Secret') ?? '';
  let diff=expected.length ^ given.length;
  for(let i=0;i<Math.min(expected.length,given.length);i++)diff|=expected.charCodeAt(i)^given.charCodeAt(i);
  if(!expected||diff)return c.json({ok:false,error:'unauthorized'},401);
  let stage='setup';
  try {
    const {directThink}=await import('../lib/diana-direct-think.mjs');
    const pixel='iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAMAjAsK7+PTMRPLhGQd7QJnESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ESJ3ES53Vg6wNShQF/fRSLfgAAAABJRU5ErkJggg==';
    stage='image';const image=await directThink(c.env,'image')([{role:'user',content:'Name the single color of the image in English using one word.',images:[{mediaType:'image/png',data:pixel}]}],{model:'gpt-6.1-terra'});
    stage='reply';
    const out=await directThink(c.env,'reply')([{role:'user',content:'Reply with the single word OK.'}],{model:'gpt-6.1-terra'});
    const imageOk=/\bred\b/i.test(image.text);
    return c.json({ok:imageOk&&out.text.trim().toLowerCase().startsWith('ok'),model_verified:out.receipt.model==='gpt-6.1-terra',image_verified:imageOk});
  } catch (error) { const code=String((error as Error)?.message??''); return c.json({ok:false,error:/^direct_(?:inference_http_\d{3}|upstream_http_\d{3}|upstream_model_not_verified|upstream_empty_answer(?:_(?:completed|failed|incomplete|no_terminal))?|upstream_codex_no_pass|inference_invalid_receipt|subscription_unavailable|invalid_model|invalid_image)$/.test(code)?code:'subscription_check_failed',stage},503); }
});
const tiktokSource=(id:string,body:any)=>({contentId:id,claimId:body.claim_id,sourceSha256:String(body.source_sha256??''),sourceAssetUrl:`https://org.dasexperten.com/assets/ugc/${body.source_sha256??''}/original.mp4`,sourceDurationSeconds:Number(body.source_duration_seconds),sourceAuthor:body.source_author,sourceUrl:body.source_url,sourceDriveId:body.source_drive_id});

route.post('/hard-answer', async (c) => {
  c.header('Cache-Control', 'no-store');
  const secret = c.env.EMAILER_SERVICE_SECRET;
  const given = c.req.header('X-Emailer-Service-Secret') ?? '';
  let diff = secret ? secret.length ^ given.length : 1;
  for (let i = 0; secret && i < Math.min(secret.length, given.length); i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  if (!secret || diff) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({})) as { message_id?: number; choice?: string };
  const messageId = Number(body.message_id);
  const choice = String(body.choice ?? '').trim();
  if (!Number.isFinite(messageId) || !choice) return c.json({ ok: false, error: 'message_id and choice required' }, 400);
  return c.json({ ok: true, ...(await answerHardQuestion(c.env, messageId, choice)) });
});

// The machine queue uses the existing service credential, never an ERP user's browser token.
route.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const secret = c.env.EMAILER_SERVICE_SECRET;
  const given = c.req.header('X-Emailer-Service-Secret') ?? '';
  let diff = secret ? secret.length ^ given.length : 1;
  for (let i = 0; secret && i < Math.min(secret.length, given.length); i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  if (!secret || diff) return c.json({ ok: false, error: 'unauthorized' }, 401);
  return next();
});

// Review pressure is metadata only: never expose the message or review reason.
route.get('/diana-review-pressure', async c => {
  const now=Date.now();
  const rows=await c.env.DB.prepare(`SELECT COALESCE(json_extract(value,'$.review_owner'),'unassigned') AS owner,
    COUNT(*) AS count, MIN(COALESCE(json_extract(value,'$.review_since_ms'),updated_at)) AS oldest_ms
    FROM crm_sync_state WHERE (key LIKE 'diana_cloud_event:%' OR key LIKE 'diana_direct_event:%') AND json_valid(value)
    AND json_extract(value,'$.status')='needs_review' GROUP BY owner`).all<{owner:string;count:number;oldest_ms:number}>();
  return c.json({ok:true,as_of_ms:now,groups:(rows.results??[]).map(row=>({...row,oldest_age_ms:Math.max(0,now-Number(row.oldest_ms))}))});
});

// The signal is preflight transport data; its task text is the actual upload
// assignment. Older installed clients forward it only after an accepted claim.
// Never send a model a contradictory "Preflight only" instruction after claim.
route.get('/reel-alarm', async (c) => {
  if((await c.env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_cloud_mode'").first<{value:string}>())?.value==='enabled')return c.json({ok:true,name:ALARM,alarm:ALARM,target:'diter-ugc-round',ready:false,executor:'cloudflare_workflow',job:null});
  const stored=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(ALARM).first<{value:string}>();
  const signal=freshSignal(stored?.value ?? '');
  const row=signal ? await c.env.DB.prepare(`SELECT j.*,c.content_url,p.handle FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id WHERE j.content_id=? AND j.status='queued' AND j.attempts<3`).bind(signal.content_id).first<{content_id:string;content_url:string;handle:string;required_destinations:string;publications:string}>() : null;
  const name=alarmWireName(c.req.header('X-UGC-Alarm-Name'));
  const wireSignal=stored?{...JSON.parse(stored.value),name}:null;
  return c.json({ok:true,name,alarm:ALARM,target:'diter-ugc-round',ready:Boolean(row),signal:wireSignal,
    job:row?{...reelJobScopeView(row),task:reelTaskText({...row,claim_id:'USE_ACTUAL_RUNTIME_CLAIM'},new URL(c.req.url).origin)}:null});
});
route.get('/reel-jobs', async (c) => {
  const jobs = await c.env.DB.prepare(`SELECT j.*,c.content_url,c.content_type,p.handle,p.platform FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id ORDER BY j.requested_at`).all();
  // claim_id is returned only to the executor that claims the job.
  return c.json({ ok: true, jobs: (jobs.results ?? []).map((row) => { const { claim_id: _claim, ...job } = row; return reelJobScopeView(job as any); }) });
});
// Backward-compatible installed PC: its real tool preflight precedes this
// exact acceptance. It cannot choose another post or bypass the one alarm.
route.post('/reel-jobs/:id/claim', async (c) => {
  const assignment=await acceptLegacyReel(c.env,c.req.param('id'),new URL(c.req.url).origin);
  if (!assignment) return c.json({ok:false,error:'alarm_not_ready_busy_cooldown_or_consumer_owned'},409);
  return c.json({ok:true,...assignment});
});
route.get('/alarm/status', async (c) => {
  const state = await c.env.DB.prepare('SELECT * FROM ugc_reel_alarm WHERE id=1').first<Record<string, any>>();
  const jobs = await c.env.DB.prepare("SELECT status,COUNT(*) count FROM ugc_reel_jobs GROUP BY status").all();
  return c.json({ok:true,alarm:ALARM,schedule:{timezone:'Europe/Moscow',...MOSCOW_SCHEDULE},runner:'diter-ugc-round',default_destination_scope:reelScope(),consumer_ttl_ms:CONSUMER_TTL_MS,state,jobs:jobs.results ?? []});
});
route.post('/alarm/pulse', async (c) => {
  if((await c.env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_cloud_mode'").first<{value:string}>())?.value==='enabled')return c.json({ok:false,error:'cloud_executor_selected'},409);
  const body = await c.req.json().catch(() => null) as {consumer_id?:string;ready?:boolean;capabilities?:string[]} | null;
  const id = body?.consumer_id ?? '';
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(id) || typeof body?.ready !== 'boolean' || !Array.isArray(body?.capabilities) || !body.capabilities.includes('diter-ugc-round')) return c.json({ok:false,error:'valid_consumer_ready_capability_required'},422);
  const now=Date.now();
  const changed=await c.env.DB.prepare(`UPDATE ugc_reel_alarm SET consumer_id=?,heartbeat_at=?,ready=? WHERE id=1
    AND (consumer_id IS NULL OR consumer_id=? OR (heartbeat_at<? AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')))`)
    .bind(id,now,body.ready ? 1:0,id,now-CONSUMER_TTL_MS).run();
  return c.json({ok:Boolean(changed.meta.changes),consumer_id:id,heartbeat_at:now},changed.meta.changes?200:409);
});
route.get('/alarm/assignment', async (c) => {
  const id=c.req.query('consumer_id') ?? '';
  if (!id) return c.json({ok:false,error:'consumer_id_required'},422);
  return c.json({ok:true,assignment:await reelAssignment(c.env,id,new URL(c.req.url).origin)});
});
route.post('/alarm/ack', async (c) => {
  const body=await c.req.json().catch(()=>null) as {consumer_id?:string;content_id?:string;claim_id?:string} | null;
  if (!body?.consumer_id || !body.content_id || !body.claim_id) return c.json({ok:false,error:'exact_assignment_required'},422);
  const result=await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET acknowledged_at=COALESCE(acknowledged_at,?),updated_at=? WHERE content_id=? AND claim_id=? AND consumer_id=? AND status='working'`).bind(new Date().toISOString(),new Date().toISOString(),body.content_id,body.claim_id,body.consumer_id).run();
  return c.json({ok:Boolean(result.meta.changes)},result.meta.changes?200:409);
});
// Persist each verified placement while remaining yellow until the task is done.
// Exact caption/provenance plan is immutable for one execution claim. It is
// evidence before provider intent, never proof that an external post exists.
route.get('/reel-jobs/:id/caption-plan', async (c) => {
  const id=c.req.param('id');
  const job=await c.env.DB.prepare('SELECT claim_id FROM ugc_reel_jobs WHERE content_id=?').bind(id).first<{claim_id:string|null}>();
  if(!job) return c.json({ok:false,error:'reel_job_not_found'},404);
  const claim=c.req.query('claim_id')??job.claim_id;
  if(!claim||claim.length>128) return c.json({ok:false,error:'claim_id_required'},422);
  const saved=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-caption-plan:${id}:${claim}`).first<{value:string}>();
  if(!saved) return c.json({ok:false,error:'caption_plan_not_found'},404);
  return c.json({ok:true,content_id:id,claim_id:claim,caption_plan_saved:true,plan:JSON.parse(saved.value)});
});
route.post('/reel-jobs/:id/upload-complete',async(c)=>{
 const b=await c.req.json().catch(()=>null);if(!b?.claim_id)return c.json({ok:false,error:'exact_claim_required'},422);
 try{return c.json({ok:true,...await finishDieterUploads(c.env,c.req.param('id'),b.claim_id)});}catch{return c.json({ok:false,error:'upload_completion_not_confirmed'},409);}
});
route.post('/reel-jobs/:id/upload-accepted',async(c)=>{
 const id=c.req.param('id'),b=await c.req.json().catch(()=>null);
 if(!b?.claim_id||b.provider_accepted!==true||typeof b.provider_id!=='string'||!b.provider_id.trim()||b.provider_id.length>256||!/^[a-f0-9]{64}$/.test(b.source_sha256??''))return c.json({ok:false,error:'exact_provider_acceptance_required'},422);
 const j=await c.env.DB.prepare("SELECT required_destinations FROM ugc_reel_jobs WHERE content_id=? AND claim_id=? AND status IN ('working','uploaded','published')").bind(id,b.claim_id).first<any>();
 if(!j||!reelScope(j).active.includes(b.platform))return c.json({ok:false,error:'exact_working_destination_required'},409);
 const key=`ugc-upload-accepted:${id}:${b.claim_id}:${b.platform}`,value=JSON.stringify({content_id:id,claim_id:b.claim_id,platform:b.platform,provider_id:b.provider_id,source_sha256:b.source_sha256,provider_accepted:true});
 await c.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,value,Date.now()).run();
 const r=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();
 if(r?.value!==value)return c.json({ok:false,error:'immutable_acceptance_conflict'},409);
 return c.json({ok:true,provider_id_saved:true,...await finishDieterUploads(c.env,id,b.claim_id)});
});
route.post('/reel-jobs/:id/tiktok/start', async (c) => {
 const body=await c.req.json().catch(()=>null);
 if(!body)return c.json({ok:false,error:'tiktok_source_required'},422);
 try{
  const result=await scheduleDieterTikTokTransport(c.env,tiktokSource(c.req.param('id'),body),body.continuation_id,body.after_code_repair===true);
  return c.json({ok:true,...result},202);
 }catch(error){const message=String((error as Error).message);return c.json({ok:false,error:/^dieter_tiktok_[a-z_]+$/.test(message)?message:'dieter_tiktok_schedule_failed'},409);}
});
route.post('/reel-jobs/:id/tiktok/preflight',async(c)=>{
 const body=await c.req.json().catch(()=>null);if(!body)return c.json({ok:false,error:'tiktok_source_required'},422);
 if(await c.env.DB.prepare("SELECT key FROM crm_sync_state WHERE key IN ('dieter_cloud_runtime_stop','dieter_cloud_preflight_blocked') LIMIT 1").first())return c.json({ok:false,error:'dieter_tiktok_runtime_incident_stop'},409);
 const result=await runDieterTikTokApi(c.env,tiktokSource(c.req.param('id'),body),'preflight');
 return c.json({ok:result.status==='preflight_ready',model_calls:0,provider_publish_calls:0,...result},result.status==='preflight_ready'?200:409);
});
route.post('/reel-jobs/:id/rutube/pending',async(c)=>{
 const id=c.req.param('id'),body=await c.req.json().catch(()=>null);
 if(!body?.claim_id||!/^[a-f0-9]{32}$/.test(body.video_id??'')||!/^[a-f0-9]{64}$/.test(body.source_sha256??'')||!Number.isFinite(body.duration_seconds)||body.duration_seconds<=0)return c.json({ok:false,error:'exact_rutube_pending_identity_required'},422);
 const job=await c.env.DB.prepare("SELECT claim_id FROM ugc_reel_jobs WHERE content_id=? AND status='working'").bind(id).first<{claim_id:string}>();
 if(job?.claim_id!==body.claim_id)return c.json({ok:false,error:'working_claim_required'},409);
 const key=`ugc-rutube-pending:${id}:${body.claim_id}`,value=JSON.stringify({video_id:body.video_id,source_sha256:body.source_sha256,duration_seconds:body.duration_seconds});
 await c.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,value,Date.now()).run();
 const saved=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();
 if(saved?.value===value)await finishDieterUploads(c.env,id,body.claim_id);
 return saved?.value===value?c.json({ok:true,provider_id_saved:true}):c.json({ok:false,error:'rutube_pending_identity_immutable'},409);
});
route.get('/reel-jobs/:id/tiktok/status',async(c)=>{
 const sha=c.req.query('source_sha256')??'';if(!/^[a-f0-9]{64}$/.test(sha))return c.json({ok:false,error:'source_sha256_required'},422);
 const row=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-tiktok-business:${c.req.param('id')}:${sha}`).first<{value:string}>();
 if(!row)return c.json({ok:true,status:'not_started'});
 const ledger=JSON.parse(row.value),job=await c.env.DB.prepare('SELECT status,publications FROM ugc_reel_jobs WHERE content_id=?').bind(c.req.param('id')).first<{status:string;publications:string}>();
 const erpSaved=Boolean(ledger.proof&&JSON.parse(job?.publications??'[]').some((p:any)=>p.platform==='tiktok'&&p.url===ledger.proof.url&&p.verified===true));
 return c.json({ok:true,status:ledger.state,provider_id:ledger.shareId??null,upload_accepted:['accepted','verified'].includes(ledger.state)&&Boolean(ledger.shareId),upload_completed:['uploaded','published'].includes(job?.status??''),publication_verified:erpSaved,provider_status:ledger.state==='accepted'?'accepted_processing':ledger.state,proof:ledger.proof??null,erp_saved:erpSaved,job_status:job?.status??null});
});
// Dedicated copywriting call; the upload executor remains pinned to Terra.
route.post('/reel-jobs/:id/headline', async c=>{
 const id=c.req.param('id'),body=await c.req.json().catch(()=>null);
 const job=await c.env.DB.prepare('SELECT status,claim_id FROM ugc_reel_jobs WHERE content_id=?').bind(id).first<any>();
 if(!body?.claim_id||job?.status!=='working'||job.claim_id!==body.claim_id)return c.json({ok:false,error:'working_claim_required'},409);
 const brief=body.brief;
 if(!brief||!['author','source_caption','scene_evidence','profile_context'].every(k=>typeof brief[k]==='string'&&brief[k].trim())||!Array.isArray(brief.verified_products)||JSON.stringify(brief).length>80000)return c.json({ok:false,error:'source_grounded_headline_brief_required'},422);
 const key=`ugc-alexandra-headline:${id}`;
 const old=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<any>();
 if(old){const value=JSON.parse(old.value);if(value.state==='ready')return c.json({ok:true,headline_key:key,...value});return c.json({ok:false,error:'headline_pending_or_unknown_no_replay'},409);}
 const reserved=await c.env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,JSON.stringify({state:'generating',claim_id:body.claim_id}),Date.now()).run();
 if(!reserved.meta.changes)return c.json({ok:false,error:'headline_already_reserved'},409);
 try{
  const rows=await c.env.DB.prepare("SELECT json_extract(value,'$.headline') headline FROM crm_sync_state WHERE key LIKE 'ugc-alexandra-headline:%' AND json_valid(value) AND json_extract(value,'$.state')='ready' ORDER BY updated_at DESC LIMIT 100").all<any>();
  const result=await writeAlexandraHeadline(c.env,brief,(rows.results??[]).map((r:any)=>r.headline));
  const value={state:'ready',content_id:id,claim_id:body.claim_id,...result,created_at:new Date().toISOString()};
  await c.env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=?').bind(JSON.stringify(value),Date.now(),key).run();
  return c.json({ok:true,headline_key:key,...value});
 }catch{
  await c.env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=?').bind(JSON.stringify({state:'unconfirmed',claim_id:body.claim_id}),Date.now(),key).run();
  return c.json({ok:false,error:'alexandra_headline_unconfirmed_do_not_substitute_terra'},503);
 }
});
route.post('/reel-jobs/:id/caption-plan', async (c) => {
  const id=c.req.param('id');
  const body=await c.req.json().catch(()=>null) as {claim_id?:string;plan?:any}|null;
  if(!body?.claim_id) return c.json({ok:false,error:'claim_id_required'},422);
  const job=await c.env.DB.prepare('SELECT status,claim_id,required_destinations FROM ugc_reel_jobs WHERE content_id=?').bind(id).first<{status:string;claim_id:string;required_destinations:string}>();
  if(!job||job.status!=='working'||job.claim_id!==body.claim_id) return c.json({ok:false,error:'working_claim_required'},409);
  const plan=body.plan, platforms=plan?.platforms;
  const keys=platforms&&typeof platforms==='object'&&!Array.isArray(platforms)?Object.keys(platforms):[];
  const scope=reelScope(job),active=[...scope.active,...scope.optional];
  const valid=plan?.content_id===id&&typeof plan.policy_id==='string'&&plan.policy_id.length>0&&keys.length>0&&keys.every(key=>{
    const item=platforms[key],p=item?.product_keyword_provenance;
    return active.includes(key)&&typeof item.caption==='string'&&item.caption.trim().length>0&&Array.isArray(item.hashtags)&&item.hashtags.length>0
      &&item.native_topic_applied===false&&typeof item.selection_evidence==='string'&&item.selection_evidence.trim().length>0
      &&p&&Array.isArray(p.verified_products)&&Array.isArray(p.selected_keyword_phrases)
      &&((p.verified_products.length>0&&(p.keyword_status==='missing_pool'||(p.keyword_status==='sourced_pool'&&typeof p.keyword_pool_id==='string'&&typeof p.source_ref==='string'&&/^[a-f0-9]{64}$/.test(p.source_sha256))))
        ||(p.verified_products.length===0&&p.keyword_status==='source_caption_only'&&p.product_resolution?.status==='unresolved'
          &&['author','source_caption','evidence'].every(field=>typeof p.product_resolution[field]==='string'&&p.product_resolution[field].trim().length>0)
          &&item.caption.toLowerCase().includes(p.product_resolution.author.toLowerCase())
          &&p.keyword_pool_id===null&&p.selected_keyword_phrases.length===0));
  });
  if(!valid||JSON.stringify(plan).length>100000) return c.json({ok:false,error:'source_specific_caption_provenance_plan_required'},422);
  const prior=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-caption-plan:${id}:${body.claim_id}`).first<any>();
  if(!prior){
   const row=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(`ugc-alexandra-headline:${id}`).first<any>();
   const headline=row?JSON.parse(row.value):null;
   if(headline?.state!=='ready'||headline.model!=='gpt-6-astra'||!keys.every(k=>platforms[k].caption.split('\n')[0].trim()===headline.headline))return c.json({ok:false,error:'verified_alexandra_astra_headline_required'},422);
  }
  const key=`ugc-caption-plan:${id}:${body.claim_id}`,value=JSON.stringify(plan);
  await c.env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND status='working' AND claim_id=?) ON CONFLICT(key) DO NOTHING`).bind(key,value,Date.now(),id,body.claim_id).run();
  const saved=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(key).first<{value:string}>();
  if(!saved) return c.json({ok:false,error:'working_claim_changed'},409);
  if(saved.value!==value) return c.json({ok:false,error:'caption_plan_already_saved_different_do_not_overwrite'},409);
  return c.json({ok:true,content_id:id,caption_plan_saved:true,platforms:keys});
});
route.post('/reel-jobs/:id/progress', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as {claim_id?:string;publications?:unknown}|null;
  if (!body?.claim_id) return c.json({ok:false,error:'claim_id_required'},422);
  const job = await c.env.DB.prepare(`SELECT j.status,j.claim_id,j.publications,j.started_at,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?`).bind(id).first<{status:string;claim_id:string;publications:string;started_at:string;content_url:string}>();
  if (!job || job.status!=='working' || job.claim_id!==body.claim_id) return c.json({ok:false,error:'claim_mismatch_or_not_working'},409);
  const proofs = reelPublicationProof(body.publications,job.content_url);
  if (!proofs) return c.json({ok:false,error:'verified_publication_required'},422);
  let existing: ReelPublication[], publications: ReelPublication[];
  try { existing=JSON.parse(job.publications); if(!Array.isArray(existing)) throw new Error(); publications=appendPublicationProofs(existing,proofs); }
  catch { return c.json({ok:false,error:'existing_publications_invalid'},409); }
  if(publications.length===existing.length) return c.json({ok:true,status:'working',added:0,publications:existing});
  const result=await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET publications=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=? AND publications=?`).bind(JSON.stringify(publications),new Date().toISOString(),id,body.claim_id,job.publications).run();
  if(!result.meta.changes) return c.json({ok:false,error:'publication_conflict_read_again'},409);
  return c.json({ok:true,status:'working',added:publications.length-existing.length,publications});
});
route.post('/reel-jobs/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; publications?: unknown } | null;
  if (!body?.claim_id) return c.json({ ok: false, error: 'claim_id_required' }, 422);
  const content = await c.env.DB.prepare('SELECT c.content_url,j.started_at,j.required_destinations,j.publications FROM ugc_content c JOIN ugc_reel_jobs j ON j.content_id=c.id WHERE c.id=?').bind(id).first<{ content_url: string; started_at: string; required_destinations: string; publications: string }>();
  const proofs = reelPublicationProof(body.publications, content?.content_url ?? '');
  if (!proofs) return c.json({ ok: false, error: 'verified_publication_required' }, 422);
  let publications: ReelPublication[];
  try { const existing=JSON.parse(content?.publications ?? '[]'); if (!Array.isArray(existing)) throw new Error(); publications=appendPublicationProofs(existing,proofs); }
  catch { return c.json({ok:false,error:'existing_publications_invalid'},409); }
  const required: string[] = reelScope(content ?? {}).active;
  if(!required.length)return c.json({ok:false,error:'no_active_destinations'},422);
  const missing = required.filter(platform => !publications.some(proof => proof.platform === platform));
  if (missing.length) return c.json({ok:false,error:'required_destinations_missing',missing},422);
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='published',publications=?,published_at=?,last_error=NULL,updated_at=? WHERE content_id=? AND status='working' AND claim_id=? AND publications=? AND (consumer_id IS NULL OR acknowledged_at IS NOT NULL)`).bind(JSON.stringify(publications), now, now, id, body.claim_id,content?.publications ?? '[]').run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'claim_mismatch_or_not_working' }, 409);
  await saveDieterFlowTiming(c.env,id,body.claim_id);
  return c.json({ ok: true, content_id: id, status: 'published', destination_scope:reelScope(content ?? {}), publications });
});
route.get('/reel-jobs/:id/timing',async(c)=>{
 const job=await c.env.DB.prepare('SELECT claim_id FROM ugc_reel_jobs WHERE content_id=?').bind(c.req.param('id')).first<{claim_id:string}>();
 if(!job?.claim_id)return c.json({ok:false,error:'flow_timing_not_available'},404);
 const timing=await saveDieterFlowTiming(c.env,c.req.param('id'),job.claim_id);
 return timing?c.json({ok:true,timing}):c.json({ok:false,error:'flow_not_complete'},409);
});
// UGC Selection: later verified placements append without reopening the job or
// replacing its first publication timestamp. Compare-and-swap prevents lost updates.
route.post('/reel-jobs/:id/publications', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { publications?: unknown } | null;
  const job = await c.env.DB.prepare(`SELECT j.status,j.publications,j.started_at,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?`).bind(id).first<{ status: string; publications: string; started_at: string; content_url: string }>();
  if (!job) return c.json({ ok: false, error: 'not_found' }, 404);
  if (job.status !== 'published') return c.json({ ok: false, error: 'published_job_required' }, 409);
  const proofs = reelPublicationProof(body?.publications, job.content_url);
  if (!proofs || proofs.some((proof) => Date.parse(proof.verified_at) < Date.parse(job.started_at))) return c.json({ ok: false, error: 'verified_publication_required' }, 422);
  let existing: ReelPublication[];
  try { existing = JSON.parse(job.publications); if (!Array.isArray(existing)) throw new Error('not_array'); }
  catch { return c.json({ ok: false, error: 'existing_publications_invalid' }, 409); }
  let publications: ReelPublication[];
  try { publications = appendPublicationProofs(existing, proofs); }
  catch { return c.json({ ok: false, error: 'existing_publications_invalid' }, 409); }
  const added = publications.length - existing.length;
  if (!added) return c.json({ ok: true, content_id: id, status: 'published', added: 0, publications: existing });
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET publications=?,updated_at=? WHERE content_id=? AND status='published' AND publications=?`).bind(JSON.stringify(publications), new Date().toISOString(), id, job.publications).run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'publication_conflict_read_again' }, 409);
  return c.json({ ok: true, content_id: id, status: 'published', added, publications });
});
// Owner-attended reconciliation of already verified placements after scope change.
// Does not claim, wake, download or publish; preserves the saved historical requirements.
route.post('/reel-jobs/:id/reconcile-scope', async (c) => {
  const id=c.req.param('id');
  const body=await c.req.json().catch(()=>null) as {scope_version?:string}|null;
  if(body?.scope_version!==REEL_SCOPE_VERSION)return c.json({ok:false,error:'exact_scope_version_required'},422);
  const job=await c.env.DB.prepare(`SELECT j.*,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?`).bind(id).first<Record<string,any>>();
  if(!job)return c.json({ok:false,error:'not_found'},404);
  if(job.status==='working')return c.json({ok:false,error:'working_assignment_must_complete_itself'},409);
  const scope=reelScope(job);
  if(!scope.active.length)return c.json({ok:false,error:'no_active_destinations',destination_scope:scope},422);
  let proofs:ReelPublication[]|null;
  try{proofs=reelPublicationProof(JSON.parse(job.publications),job.content_url);}catch{proofs=null;}
  if(!proofs)return c.json({ok:false,error:'saved_verified_proofs_required'},422);
  const missing=scope.active.filter(platform=>!proofs!.some(p=>p.platform===platform));
  if(missing.length)return c.json({ok:false,error:'active_destinations_missing',missing,destination_scope:scope},422);
  if(job.status==='published')return c.json({ok:true,status:'published',already_complete:true,destination_scope:scope,publications:proofs});
  const now=new Date().toISOString();
  const result=await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='published',published_at=COALESCE(published_at,?),last_error=NULL,updated_at=? WHERE content_id=? AND status='queued' AND publications=? AND required_destinations=?`).bind(now,now,id,job.publications,job.required_destinations),
    c.env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND status='published') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind('ugc-reel-scope:'+id,JSON.stringify({...scope,reason:'Owner 10Nov: Wibes/Ozon excluded pending publishing access; original requested destinations preserved',completion:'attended_existing_proofs',verified_at:now}),Date.now(),id),
  ]);
  if(!result[0].meta.changes)return c.json({ok:false,error:'scope_reconcile_conflict_read_again'},409);
  return c.json({ok:true,content_id:id,status:'published',destination_scope:scope,publications:proofs});
});
// Owner 08.11.2026: after three failed attempts the frame is red and the
// next reel may run. Quarantine preserves partial/uncertain publication facts;
// it is exhausted, so no future automatic upload can duplicate them.
route.post('/reel-jobs/:id/block', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; error?: string; failed_attempts?: number } | null;
  const error = String(body?.error ?? '').trim().slice(0, 1000);
  if (!body?.claim_id || !error || body.failed_attempts !== 3) return c.json({ ok: false, error: 'claim_reason_and_three_failed_attempts_required' }, 422);
  if(await awaitsDieterApiCompletion(c.env,id,body.claim_id))return c.json({ok:true,status:'working',api_completion_pending:true});
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='queued',attempts=MAX(attempts,3),claim_id=NULL,consumer_id=NULL,acknowledged_at=NULL,last_error=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=?`)
    .bind(error, new Date().toISOString(), id, body.claim_id).run();
  return c.json({ ok: Boolean(result.meta.changes), status: 'queued', blocked: true, automatic_retry: false }, result.meta.changes ? 200 : 409);
});
route.post('/reel-jobs/:id/release', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; error?: string } | null;
  const error = String(body?.error ?? '').trim().slice(0, 1000);
  if (!body?.claim_id || !error) return c.json({ ok: false, error: 'claim_and_reason_required' }, 422);
  if(await awaitsDieterApiCompletion(c.env,id,body.claim_id))return c.json({ok:true,status:'working',api_completion_pending:true});
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL,last_error=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=?`).bind(error, new Date().toISOString(), id, body.claim_id).run();
  return c.json({ ok: Boolean(result.meta.changes), status: 'queued' }, result.meta.changes ? 200 : 409);
});
// Wake only the alarm; it still enforces windows, spacing and live consumer.
route.post('/reel-jobs/:id/dispatch', async (c) => {
  const job=await c.env.DB.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').bind(c.req.param('id')).first<{status:string}>();
  if (job?.status!=='queued') return c.json({ok:false,error:'queued_job_required'},409);
  return c.json(await tickDiterAlarm(c.env,Date.now(),c.req.param('id')));
});

route.route('/', instagramOperationRoutes);
route.post('/cloud/preflight',async c=>{
 const response=await c.env.DIETER_WAKE.get(c.env.DIETER_WAKE.idFromName('dieter')).fetch(new Request('https://dieter.internal/preflight',{method:'POST'}));
 return new Response(response.body,{status:response.status,headers:new Headers(response.headers)});
});
// Owner-authorized incident acceptance: only the fixed read-only preflight,
// never a work call, claim, publication or implicit stop removal.
route.post('/cloud/repair-preflight',async c=>{
 const body=await c.req.json().catch(()=>null);
 if(!body?.claim_id)return c.json({ok:false,error:'exact_incident_claim_required'},422);
 const r=await c.env.DIETER_WAKE.get(c.env.DIETER_WAKE.idFromName('dieter')).fetch(new Request('https://dieter.internal/repair-preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claim_id:body.claim_id})}));
 return new Response(r.body,{status:r.status,headers:new Headers(r.headers)});
});
// Fixed, model-free diagnostic crosses the former long RPC failure boundary.
// No caller-supplied command, provider operation or credential is accepted.
route.post('/cloud/runtime-probe',async c=>{
 const body=await c.req.json().catch(()=>null);
 if(!body?.claim_id||typeof body.request_id!=='string'||!/^runtime-probe:[A-Za-z0-9_-]{1,100}$/.test(body.request_id))return c.json({ok:false,error:'invalid_diagnostic_identity'},422);
 const stop=await c.env.DB.prepare("SELECT value FROM crm_sync_state WHERE key='dieter_cloud_runtime_stop'").first<{value:string}>();
 if(!stop||JSON.parse(stop.value).claim_id!==body.claim_id)return c.json({ok:false,error:'exact_incident_claim_required'},409);
 if(await c.env.DB.prepare("SELECT content_id FROM ugc_reel_jobs WHERE status='working' LIMIT 1").first())return c.json({ok:false,error:'active_execution_exists'},409);
 if(!c.env.DIETER_SUBSCRIPTION)return c.json({ok:false,error:'dieter_execution_binding_missing'},503);
 const r=await c.env.DIETER_SUBSCRIPTION.fetch('https://subscription.internal/runtime-probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:body.request_id})});
 return new Response(r.body,{status:r.status,headers:new Headers(r.headers)});
});
route.get('/cloud/runtime-result/:requestId',async c=>{
 const id=c.req.param('requestId');if(!/^runtime-probe:[A-Za-z0-9_-]{1,100}$/.test(id))return c.json({ok:false,error:'invalid_diagnostic_identity'},422);
 if(!c.env.DIETER_SUBSCRIPTION)return c.json({ok:false,error:'dieter_execution_binding_missing'},503);
 const r=await c.env.DIETER_SUBSCRIPTION.fetch('https://subscription.internal/result/'+encodeURIComponent(id),{method:'GET'});
 return new Response(r.body,{status:r.status,headers:new Headers(r.headers)});
});
route.get('/cloud/contract',async c=>{
 if(!c.env.DIETER_SUBSCRIPTION)return c.json({ok:false,error:'dieter_execution_binding_missing'},503);
 const response=await c.env.DIETER_SUBSCRIPTION.fetch('https://subscription.internal/contract');
 return new Response(response.body,{status:response.status,headers:new Headers(response.headers)});
});
export default route;
