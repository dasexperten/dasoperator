// =============================================================================
// Admin routes for self-healing infrastructure
//
//   GET  /api/admin/auto-heal/status      — recent failures + heal log
//   GET  /api/admin/auto-heal/recipes     — list playbook
//   POST /api/admin/auto-heal/test        — force-trigger a failure for testing
//
// No auth gating here yet — same posture as other admin endpoints.
// Wire Cloudflare Access on top later (Phase 2.x).
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { reportCronFailure } from '../lib/auto-healer';

const route = new Hono<{ Bindings: Env }>();

route.get('/status', async (c) => {
  const recent = await c.env.DB.prepare(
    `SELECT id, service_name, occurred_at, error_message, error_class, auto_heal_log_id
     FROM sync_failures
     ORDER BY occurred_at DESC
     LIMIT 50`
  ).all();

  const healLog = await c.env.DB.prepare(
    `SELECT id, recipe_id, service_name, action_taken, result, occurred_at, duration_ms, details
     FROM auto_heal_log
     ORDER BY occurred_at DESC
     LIMIT 50`
  ).all();

  // Per-service summary: last failure + last successful heal
  const summary = await c.env.DB.prepare(
    `SELECT service_name,
            MAX(occurred_at) AS last_failure_at,
            COUNT(*) AS total_failures_30d
     FROM sync_failures
     WHERE occurred_at >= unixepoch() - 30*86400
     GROUP BY service_name
     ORDER BY last_failure_at DESC`
  ).all();

  return c.json({
    success: true,
    result: {
      summary: summary.results || [],
      recent_failures: recent.results || [],
      heal_log: healLog.results || [],
    },
  });
});

route.get('/recipes', async (c) => {
  const recipes = await c.env.DB.prepare(
    `SELECT id, name, error_pattern, action_type, action_config, max_per_hour, enabled, description, created_at
     FROM auto_heal_recipes
     ORDER BY created_at ASC`
  ).all();
  return c.json({ success: true, result: recipes.results || [] });
});

// Test endpoint: simulate a failure and let auto-healer handle it.
// Useful for verifying TG alerts work + recipes match + actions execute.
route.post('/test', async (c) => {
  const body = await c.req.json<{ service?: string; error?: string }>().catch(() => ({}));
  const service = body.service || 'test_service';
  const errorMessage = body.error || 'no such table: main.bank_statement_files (synthetic test)';

  await reportCronFailure(c.env, service, new Error(errorMessage), { cron: 'manual_test' });

  return c.json({
    success: true,
    result: {
      message: 'Failure reported to auto-healer. Check TG and /status for outcome.',
      service,
      error: errorMessage,
    },
  });
});

export default route;
