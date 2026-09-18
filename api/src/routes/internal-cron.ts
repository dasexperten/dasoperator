// =============================================================================
// POST /internal/cron/:worker — an erp-* timer worker starts its one ERP job.
//
// Jobs whose keys live only on this Worker keep running here, on those keys;
// the timer, the name and the run log belong to the erp-* worker. The door
// sits outside /api (no user session exists on a timer) and opens only with
// ERP_RUN_SECRET, only for the model-free jobs listed below.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { handleScheduled } from '../scheduled';

const MOVED: Record<string, string> = {
  'erp-skladbot-sync': '30 */6 * * *',
  'erp-modulbank-sync': '15 * * * *',
  'erp-daily-digest': '0 3 * * *',
  'erp-pulse-warm': '0 1 * * *',
  'erp-web-analytics': '30 2 * * *',
  'erp-fbo-sync': '0 5 * * *',
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

route.post('/:worker', async (c) => {
  const secret = (c.env as unknown as { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET ?? '';
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
  if (!secret || !sameSecret(given, secret)) return c.json({ ok: false, error: 'unauthorized' }, 401);

  const worker = c.req.param('worker');
  const cron = MOVED[worker];
  if (!cron) return c.json({ ok: false, error: `no ERP job for ${worker}` }, 404);

  const started = Date.now();
  const event = { cron, scheduledTime: started, type: 'scheduled', noRetry() {} } as unknown as ScheduledEvent;
  try {
    await handleScheduled(event, c.env, c.executionCtx as ExecutionContext);
    return c.json({ ok: true, cron, ms: Date.now() - started });
  } catch (e) {
    return c.json({ ok: false, cron, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default route;
