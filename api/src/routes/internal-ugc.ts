// Owner 2026-10-17: a tap on a Diana hard-question button in Telegram arrives here
// from the organizacia bot (service binding EMAILER, same service secret as mail).
import { Hono } from 'hono';
import { reelPublicationProof, appendPublicationProofs, reelTaskText, type ReelPublication } from '../lib/ugc-reel-jobs.mjs';
import { ALARM, ROUND, CLAIM_SQL, START_GAP_MS, SIGNAL_TTL_MS, freshSignal, inMoscowWindow } from '../lib/diter-ugc-alarm.mjs';
import { dispatchReel } from '../lib/ugc-reel-store';
import type { Env } from '../types';
import { answerHardQuestion } from '../lib/ugc-hard-question';

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

route.get('/reel-alarm', async (c) => {
  const stored = await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(ALARM).first<{value:string}>();
  const signal = freshSignal(stored?.value ?? '');
  const job = signal ? await c.env.DB.prepare(`SELECT j.content_id,j.publications,c.content_url,p.handle FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id WHERE j.content_id=? AND j.status='queued' AND j.attempts<3 AND j.dispatch_attempts<3`).bind(signal.content_id).first<Record<string,any>>() : null;
  return c.json({ok:true,name:ALARM,target:ROUND,ready:Boolean(job),
    signal: stored ? JSON.parse(stored.value) : null,
    job: job ? {...job,task:reelTaskText(job,new URL(c.req.url).origin)} : null});
});
route.get('/reel-jobs', async (c) => {
  const jobs = await c.env.DB.prepare(`SELECT j.*,c.content_url,c.content_type,p.handle,p.platform FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id ORDER BY j.requested_at`).all();
  // claim_id is returned only to the executor that claims the job.
  return c.json({ ok: true, jobs: (jobs.results ?? []).map((row) => { const { claim_id: _claim, ...job } = row; return job; }) });
});
route.post('/reel-jobs/:id/claim', async (c) => {
  const id = c.req.param('id');
  const claim = crypto.randomUUID();
  const clock = new Date();
  const now = clock.toISOString();
  if (!inMoscowWindow(clock)) return c.json({ok:false,error:'outside_moscow_window'},409);
  const result = await c.env.DB.prepare(CLAIM_SQL).bind(claim,now,id,
    new Date(clock.getTime()-START_GAP_MS).toISOString(),new Date(clock.getTime()-SIGNAL_TTL_MS).toISOString()).run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'alarm_not_ready_busy_cooldown_or_attempt_limit' }, 409);
  return c.json({ ok: true, content_id: id, status: 'working', claim_id: claim });
});
// Persist each verified placement while remaining yellow until the task is done.
route.post('/reel-jobs/:id/progress', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as {claim_id?:string;publications?:unknown}|null;
  if (!body?.claim_id) return c.json({ok:false,error:'claim_id_required'},422);
  const job = await c.env.DB.prepare(`SELECT j.status,j.claim_id,j.publications,j.started_at,c.content_url FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id WHERE j.content_id=?`).bind(id).first<{status:string;claim_id:string;publications:string;started_at:string;content_url:string}>();
  if (!job || job.status!=='working' || job.claim_id!==body.claim_id) return c.json({ok:false,error:'claim_mismatch_or_not_working'},409);
  const proofs = reelPublicationProof(body.publications,job.content_url);
  if (!proofs || proofs.some(proof=>Date.parse(proof.verified_at)<Date.parse(job.started_at))) return c.json({ok:false,error:'verified_publication_required'},422);
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
  const content = await c.env.DB.prepare('SELECT c.content_url,j.started_at,j.publications FROM ugc_content c JOIN ugc_reel_jobs j ON j.content_id=c.id WHERE c.id=?').bind(id).first<{ content_url: string; started_at: string; publications:string }>();
  const proofs = reelPublicationProof(body.publications, content?.content_url ?? '');
  if (!proofs || proofs.some((proof) => Date.parse(proof.verified_at) < Date.parse(content?.started_at ?? ''))) return c.json({ ok: false, error: 'verified_publication_required' }, 422);
  const now = new Date().toISOString();
  let publications: ReelPublication[];
  try { const existing=JSON.parse(content?.publications ?? '[]'); if(!Array.isArray(existing)) throw new Error(); publications=appendPublicationProofs(existing,proofs); }
  catch { return c.json({ok:false,error:'existing_publications_invalid'},409); }
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='published',publications=?,published_at=?,last_error=NULL,updated_at=? WHERE content_id=? AND status='working' AND claim_id=? AND publications=?`).bind(JSON.stringify(publications), now, now, id, body.claim_id,content?.publications ?? '[]').run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'claim_mismatch_or_not_working' }, 409);
  return c.json({ ok: true, content_id: id, status: 'published', publications });
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
route.post('/reel-jobs/:id/release', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; error?: string } | null;
  const error = String(body?.error ?? '').trim().slice(0, 1000);
  if (!body?.claim_id || !error) return c.json({ ok: false, error: 'claim_and_reason_required' }, 422);
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='queued',claim_id=NULL,last_error=?,updated_at=? WHERE content_id=? AND status='working' AND claim_id=?`).bind(error, new Date().toISOString(), id, body.claim_id).run();
  return c.json({ ok: Boolean(result.meta.changes), status: 'queued' }, result.meta.changes ? 200 : 409);
});
// Explicit operator retry only: no loop, maximum three dispatch attempts in the row.
route.post('/reel-jobs/:id/dispatch', async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET dispatched_at=NULL WHERE content_id=? AND status='queued' AND dispatch_attempts<3`).bind(id).run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'not_queued_or_attempt_limit' }, 409);
  c.executionCtx.waitUntil(dispatchReel(c.env, id, new URL(c.req.url).origin));
  return c.json({ ok: true, status: 'queued' });
});

export default route;
