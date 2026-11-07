// Owner 2026-10-17: a tap on a Diana hard-question button in Telegram arrives here
// from the organizacia bot (service binding EMAILER, same service secret as mail).
import { Hono } from 'hono';
import { ALARM, freshSignal } from '../lib/diter-ugc-alarm.mjs';
import { reelPublicationProof, appendPublicationProofs, reelTaskText, reelScope, reelJobScopeView, REEL_SCOPE_VERSION, type ReelPublication } from '../lib/ugc-reel-jobs.mjs';
import { tickDiterAlarm, reelAssignment, CONSUMER_TTL_MS, acceptLegacyReel } from '../lib/ugc-reel-store';
import type { Env } from '../types';
import { answerHardQuestion } from '../lib/ugc-hard-question';
import instagramOperationRoutes from './internal-ugc-instagram';

const route = new Hono<{ Bindings: Env }>();

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

// Legacy PC consumer sees a preflight signal only; the next call accepts this
// exact content_id before it starts the tool-capable round. Never /adhoc.
route.get('/reel-alarm', async (c) => {
  const stored=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(ALARM).first<{value:string}>();
  const signal=freshSignal(stored?.value ?? '');
  const row=signal ? await c.env.DB.prepare(`SELECT j.*,c.content_url,p.handle FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id WHERE j.content_id=? AND j.status='queued' AND j.attempts<3`).bind(signal.content_id).first<{content_id:string;content_url:string;handle:string;required_destinations:string;publications:string}>() : null;
  return c.json({ok:true,name:ALARM,target:'diter-ugc-round',ready:Boolean(row),signal:stored?JSON.parse(stored.value):null,
    job:row?{...reelJobScopeView(row),task:`Preflight only. Accept this exact post once, then use the ACTUAL returned claim_id in every callback. ${reelTaskText({...row,claim_id:'USE_ACTUAL_RUNTIME_CLAIM'},new URL(c.req.url).origin)}`}:null});
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
  return c.json({ok:true,alarm:'diter-ugc-alarm',runner:'diter-ugc-round',default_destination_scope:reelScope(),consumer_ttl_ms:CONSUMER_TTL_MS,state,jobs:jobs.results ?? []});
});
route.post('/alarm/pulse', async (c) => {
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
  return c.json({ ok: true, content_id: id, status: 'published', destination_scope:reelScope(content ?? {}), publications });
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
    c.env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE content_id=? AND status='published') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind('ugc-reel-scope:'+id,JSON.stringify({...scope,reason:'Owner active3; VK/TikTok deferred, original requirements preserved',completion:'attended_existing_proofs',verified_at:now}),Date.now(),id),
  ]);
  if(!result[0].meta.changes)return c.json({ok:false,error:'scope_reconcile_conflict_read_again'},409);
  return c.json({ok:true,content_id:id,status:'published',destination_scope:scope,publications:proofs});
});
route.post('/reel-jobs/:id/release', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; error?: string } | null;
  const error = String(body?.error ?? '').trim().slice(0, 1000);
  if (!body?.claim_id || !error) return c.json({ ok: false, error: 'claim_and_reason_required' }, 422);
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
export default route;
