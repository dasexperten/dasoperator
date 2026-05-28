// =============================================================================
// GET /api/integrations/health
// Live watchdog snapshot for every monitored integration (read-only).
// Powers the Integrations health page and feeds the watchdog cron.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { computeIntegrationHealth } from '../lib/integration-health';

const route = new Hono<{ Bindings: Env }>();

route.get('/health', async (c) => {
  const report = await computeIntegrationHealth(c.env);
  return c.json({ success: true, result: report });
});

export default route;
