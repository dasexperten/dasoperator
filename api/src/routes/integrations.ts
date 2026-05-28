// =============================================================================
// /api/integrations
//   GET  /health        — live watchdog snapshot (read-only)
//   POST /watchdog/run  — run the watchdog now (detect + safe-fix + escalate)
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { computeIntegrationHealth } from '../lib/integration-health';
import { runWatchdog } from '../lib/watchdog';

const route = new Hono<{ Bindings: Env }>();

route.get('/health', async (c) => {
  const report = await computeIntegrationHealth(c.env);
  return c.json({ success: true, result: report });
});

route.post('/watchdog/run', async (c) => {
  const r = await runWatchdog(c.env);
  return c.json({ success: true, result: r });
});

export default route;
