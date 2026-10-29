import { subscriptionInfer } from '../lib/diana-subscription.mjs';
// =============================================================================
// POST /internal/cron/:worker — an erp-* timer worker starts its one ERP job.
//
// Jobs whose keys live only on this Worker keep running here, on those keys;
// the timer, the name and the run log belong to the erp-* worker. The door
// sits outside /api (no user session exists on a timer) and opens only with
// ERP_RUN_SECRET, only for the model-free jobs listed below.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { handleScheduled } from '../scheduled';
import { STEPS } from '../cron-steps';
import { runApiStep } from '../../../workers/_shared/run-journal';

const MOVED: Record<string, string> = {
  'erp-skladbot-sync': '30 */6 * * *',
  'erp-daily-digest': '0 3 * * *',
  'erp-pulse-warm': '0 1 * * *',
  'erp-web-analytics': '30 2 * * *',
  'erp-wb-weekly-report': '0 4 * * 4',
  'erp-ozon-monthly-report': '0 3 5 * *',
  'erp-site-sales-rebuild': '0 4 1-7 * 3',
  'erp-site-orders': '7 * * * *',
  'erp-auto-delivery': '0 */4 * * *',
  'erp-watchdog': '*/10 * * * *',
  'erp-orders-drop-watch': '0 4 * * *',
  'erp-mail-retention': '0 3 1 * *',
  'erp-ozon-ads-reports': '5 */6 * * *',
};

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const route = new Hono<{ Bindings: Env }>();

function authorized(c: { env: Env; req: { header(name: string): string | undefined } }): boolean {
  const secret = (c.env as unknown as { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET ?? '';
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
  return Boolean(secret && sameSecret(given, secret));
}

// Owner 2026-10-17: the direct Modulbank API link is removed; its service doors went with it.

route.post('/:worker', async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);

  const worker = c.req.param('worker');
  const started = Date.now();
  // Diagnose the real private attachment path without sending a DM or touching
  // payments. Only a known creator handle is accepted; no arbitrary image URL.
  if (worker === 'diana-attachment-check') {
    const input = z.object({ handle: z.string().regex(/^[a-zA-Z0-9_.]{1,30}$/), message_id:z.string().min(1).max(2048).optional() }).parse(await c.req.json());
    const messages = (await c.env.DB.prepare(`SELECT id, direction, created_at, attachments_json
      FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1
      AND attachments_json IS NOT NULL AND attachments_json<>'[]' AND (?2 IS NULL OR id=?2)
      ORDER BY created_at DESC LIMIT 1`).bind(input.handle.toLowerCase(),input.message_id??null).all<{id:string;direction:string;created_at:string;attachments_json:string|null}>()).results ?? [];
    if (!messages.length) return c.json({ ok:false, error:'attachment_not_archived' },404);
    let stage='download';
    try {
      const { incomingScreenshots } = await import('../lib/ig-dm-attachments');
      const { prepareDianaContext } = await import('../lib/diana-context.mjs');
      const { checkSubscriptionImages } = await import('../lib/diana-subscription-vision.mjs');
      const screenshots = await incomingScreenshots(c.env,messages,messages[0]!.created_at);
      if (!screenshots.images.length) return c.json({ok:false,error:'attachment_download_failed',unreadable:screenshots.unreadable},503);
      stage='context';
      const prepared = await prepareDianaContext({task:'Read-only screenshot visibility verification. Read the attached marketplace screenshot. No creator reply, no payment.',githubToken:(c.env as unknown as {GITHUB_TOKEN?:string}).GITHUB_TOKEN ?? '',infer:subscriptionInfer(c.env,'context')});
      stage='jev';
      const imageCheck = await checkSubscriptionImages({images:screenshots.images,policy:prepared.imagePolicy,task:'Read-only visibility check; do not invent missing seller or payment evidence.',infer:subscriptionInfer(c.env,'image')});
      const visible = imageCheck.checks.some(check=>check.kind!=='unknown');
      return c.json({ok:visible,archived_at:messages[0]!.created_at,images:screenshots.images.length,unreadable:screenshots.unreadable,image_check:imageCheck,vision_provider:'codex-native',context:prepared.receipt,ms:Date.now()-started},visible ? 200 : 503);
    } catch (error) {
      // Only a stage and numeric HTTP status leave the diagnostic. Provider
      // error bodies can contain personal data or credentials and stay private.
      const upstreamStatus=String(error instanceof Error ? error.message : '').match(/HTTP\s+(\d{3})/i)?.[1];
      return c.json({ok:false,error:'attachment_analysis_failed',stage,upstream_status:upstreamStatus?Number(upstreamStatus):null},503);
    }
  }
  // Read-only live verification of Diana's actual runtime bindings, JEV and
  // GitHub sources. Never polls DMs, writes a reply, or starts a payment.
  if (worker === 'diana-context-check') {
    try {
      const { prepareDianaContext } = await import('../lib/diana-context.mjs');
      const result = await prepareDianaContext({ task: 'Readiness check only: an Instagram creator asks how the current TERMO barter programme works. Load Diana and the relevant skills. No real creator, no reply, no payment.',
        githubToken: (c.env as unknown as { GITHUB_TOKEN?: string }).GITHUB_TOKEN ?? '', infer: subscriptionInfer(c.env,'context') });
      const { checkSubscriptionImages } = await import('../lib/diana-subscription-vision.mjs');
      // TypeSafe's documented black-rectangle fixture; no personal image data.
      const imageCheck = await checkSubscriptionImages({ images: [{ mediaType: 'image/png', label: 'Readiness fixture: a black rectangle, not a basket.', data: 'iVBORw0KGgoAAAANSUhEUgAAARgAAAEYAQAAAACv9dQhAAAATklEQVR42u3ZoQ3AMAADwU8X6f47RkpJigqKI52pD5l6rH5zxTAMwzAMwzBMVWtnfpr7rWzIMAzDMAzDMAzDMMzpZvgQGYZhGIZhGKaqB4heFTaRz7VhAAAAAElFTkSuQmCC' }],
        task: 'Read-only test image. Do not invent a seller, product or payable amount.', policy: result.imagePolicy, infer:subscriptionInfer(c.env,'image') });
      const ready = imageCheck.checks.length > 0 && imageCheck.checks.every(check => !check.reason);
      return c.json({ ok: ready, receipt: result.receipt, image_check: imageCheck, ms: Date.now() - started }, ready ? 200 : 503);
    } catch { return c.json({ ok: false, error: 'diana_context_unavailable' }, 503); }
  }
  // erp-inventory hands over one letter (JSON body) instead of starting a timer job.
  if (worker === 'erp-inventory') {
    try {
      const { receiveInventoryMail } = await import('../lib/inventory-mail');
      const r = await receiveInventoryMail(c.env, await c.req.json());
      return c.json({ ok: r.status !== 'failed', cron: 'mail', note: `${r.status}: ${r.note}`, ms: Date.now() - started });
    } catch (e) {
      return c.json({ ok: false, cron: 'mail', error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  const step = STEPS[worker];
  const cron = step ? 'step' : MOVED[worker];
  if (!cron) return c.json({ ok: false, error: `no ERP job for ${worker}` }, 404);
  const runKey = c.req.header('X-Erp-Run-Key') ?? '';
  const triggerSource = c.req.header('X-Erp-Trigger-Source') ?? null;
  if (triggerSource !== null && !['cloudflare', 'external_clock', 'manual'].includes(triggerSource)) {
    return c.json({ ok: false, error: 'invalid ERP trigger source' }, 400);
  }
  if (runKey && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runKey)) {
    return c.json({ ok: false, error: 'invalid ERP run key' }, 400);
  }
  const trace = (phase: string) => {
    if (runKey) console.log(JSON.stringify({ worker, run_key: runKey, phase, elapsed_ms: Date.now() - started }));
  };
  const job = async (): Promise<string> => {
    if (step) return step(c.env);
    const event = { cron, scheduledTime: started, type: 'scheduled', noRetry() {} } as unknown as ScheduledEvent;
    await handleScheduled(event, c.env, c.executionCtx as ExecutionContext, true);
    return `ERP scheduled handler "${cron}" completed`;
  };
  try {
    if (runKey) {
      const pending = runApiStep(c.env.DB, worker, runKey, job, trace, triggerSource);
      // Best effort for a disconnected caller: keep completion alive for the
      // documented HTTP waitUntil grace. This is not a durable job queue.
      c.executionCtx.waitUntil(pending.catch(() => undefined));
      const result = await pending;
      return c.json({ ...result, cron, ms: Date.now() - started }, result.pending ? 409 : result.ok ? 200 : 500);
    }
    // Existing direct callers without a journal header preserve their path.
    const note = await job();
    return c.json({ ok: true, cron, note, ms: Date.now() - started });
  } catch (e) {
    trace('erp_step_or_journal_failed');
    return c.json({ ok: false, cron, error: e instanceof Error ? e.message : String(e) }, 500);
  }

});

export default route;
