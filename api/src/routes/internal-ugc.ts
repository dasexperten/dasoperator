// Owner 2026-10-17: a tap on a Diana hard-question button in Telegram arrives here
// from the organizacia bot (service binding EMAILER, same service secret as mail).
import { Hono } from 'hono';
import { reelPublicationProof, appendPublicationProofs, type ReelPublication } from '../lib/ugc-reel-jobs.mjs';
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

route.get('/reel-jobs', async (c) => {
  const jobs = await c.env.DB.prepare(`SELECT j.*,c.content_url,c.content_type,p.handle,p.platform FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id ORDER BY j.requested_at`).all();
  // claim_id is returned only to the executor that claims the job.
  return c.json({ ok: true, jobs: (jobs.results ?? []).map((row) => { const { claim_id: _claim, ...job } = row; return job; }) });
});
route.post('/reel-jobs/:id/claim', async (c) => {
  const id = c.req.param('id');
  const claim = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?,started_at=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE content_id=? AND status='queued' AND attempts<3`).bind(claim, now, now, id).run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'not_queued_or_attempt_limit' }, 409);
  return c.json({ ok: true, content_id: id, status: 'working', claim_id: claim });
});
route.post('/reel-jobs/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { claim_id?: string; publications?: unknown } | null;
  if (!body?.claim_id) return c.json({ ok: false, error: 'claim_id_required' }, 422);
  const content = await c.env.DB.prepare('SELECT c.content_url,j.started_at FROM ugc_content c JOIN ugc_reel_jobs j ON j.content_id=c.id WHERE c.id=?').bind(id).first<{ content_url: string; started_at: string }>();
  const proofs = reelPublicationProof(body.publications, content?.content_url ?? '');
  if (!proofs || proofs.some((proof) => Date.parse(proof.verified_at) < Date.parse(content?.started_at ?? ''))) return c.json({ ok: false, error: 'verified_publication_required' }, 422);
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(`UPDATE ugc_reel_jobs SET status='published',publications=?,published_at=?,last_error=NULL,updated_at=? WHERE content_id=? AND status='working' AND claim_id=?`).bind(JSON.stringify(proofs), now, now, id, body.claim_id).run();
  if (!result.meta.changes) return c.json({ ok: false, error: 'claim_mismatch_or_not_working' }, 409);
  return c.json({ ok: true, content_id: id, status: 'published', publications: proofs });
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
