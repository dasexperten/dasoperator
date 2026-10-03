// =============================================================================
// Auto-healer engine
//
// Public API:
//   reportCronFailure(env, service, error, ctx?)
//       — entry point for cron handlers. Logs failure to sync_failures,
//         attempts to find matching recipe, executes safe action if found,
//         and reports only persistent unresolved problems to the Owner.
//
// Recipes are stored in auto_heal_recipes (regex pattern → action_type).
// Actions are implemented in healer-actions.ts.
// Rate-limit per recipe enforced via max_per_hour.
// Every attempt logged to auto_heal_log.
// =============================================================================

import type { Env } from '../types';
import { executeHealAction } from './healer-actions';
import { notifyPersistentErpFailure } from './persistent-erp-alert';

interface ReportContext {
  cron?: string;
  payload?: unknown;
  occurredAt?: number;
}

interface Recipe {
  id: string;
  name: string;
  error_pattern: string;
  action_type: string;
  action_config: string;
  max_per_hour: number;
  enabled: number;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function classifyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('no such table') || m.includes('no such column')) return 'schema_mismatch';
  if (m.includes('foreign key')) return 'fk_violation';
  if (m.includes('429') || m.includes('rate limit') || m.includes('too many')) return 'rate_limit';
  if (m.includes('401') || m.includes('403') || m.includes('unauthorized')) return 'auth_failure';
  if (m.includes('500') || m.includes('502') || m.includes('503') || m.includes('504')) return 'upstream_5xx';
  if (m.includes('timeout') || m.includes('etimedout')) return 'timeout';
  if (m.includes('unique constraint')) return 'duplicate';
  return 'unknown';
}

async function findMatchingRecipe(env: Env, errMsg: string): Promise<Recipe | null> {
  const recipes = await env.DB.prepare(
    `SELECT id, name, error_pattern, action_type, action_config, max_per_hour, enabled
     FROM auto_heal_recipes WHERE enabled = 1`
  ).all<Recipe>();

  for (const r of recipes.results || []) {
    try {
      const re = new RegExp(r.error_pattern, 'i');
      if (re.test(errMsg)) return r;
    } catch {
      // skip malformed regex
    }
  }
  return null;
}

async function isRateLimited(env: Env, recipe: Recipe): Promise<boolean> {
  const hourAgo = now() - 3600;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM auto_heal_log
     WHERE recipe_id = ? AND occurred_at >= ? AND result IN ('success','failed')`
  ).bind(recipe.id, hourAgo).first<{ c: number }>();
  return (row?.c ?? 0) >= recipe.max_per_hour;
}

async function logHeal(
  env: Env,
  recipeId: string | null,
  service: string,
  errMsg: string,
  action: string,
  result: 'success' | 'failed' | 'skipped_rate_limited' | 'skipped_no_recipe',
  details: unknown,
  durationMs: number,
): Promise<string> {
  const id = `heal_${uuid()}`;
  await env.DB.prepare(
    `INSERT INTO auto_heal_log
     (id, recipe_id, service_name, triggered_by_error, action_taken, result, details, occurred_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    recipeId,
    service,
    errMsg.slice(0, 1000),
    action,
    result,
    JSON.stringify(details ?? null),
    now(),
    durationMs,
  ).run();
  return id;
}

async function logFailure(
  env: Env,
  service: string,
  cron: string | undefined,
  errMsg: string,
  payload: unknown,
  healLogId: string | null,
  occurredAt = now(),
): Promise<string> {
  const id = `fail_${uuid()}`;
  await env.DB.prepare(
    `INSERT INTO sync_failures
     (id, service_name, cron_expression, occurred_at, error_message, error_class, raw_context, notified, auto_heal_log_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    service,
    cron ?? null,
    occurredAt,
    errMsg.slice(0, 2000),
    classifyError(errMsg),
    payload ? JSON.stringify(payload).slice(0, 5000) : null,
    0,
    healLogId,
    now(),
  ).run();
  return id;
}

/**
 * Main entry point for cron handlers.
 * Call this whenever a scheduled sync/cron fails — it will:
 *   1. Log the failure to sync_failures (audit trail)
 *   2. Try to find a matching playbook recipe
 *   3. Execute the recipe's action (if rate-limit allows)
 *   4. Report only repeated unresolved failures spanning at least 24 hours
 */
export async function reportCronFailure(
  env: Env,
  service: string,
  error: unknown,
  ctx: ReportContext = {},
): Promise<void> {
  const errMsg = error instanceof Error ? error.message : String(error);
  const errClass = classifyError(errMsg);

  console.log(`[auto-healer] failure in ${service}: ${errMsg.slice(0, 200)}`);

  const recipe = await findMatchingRecipe(env, errMsg);
  let healLogId: string | null = null;

  if (!recipe) {
    healLogId = await logHeal(env, null, service, errMsg, 'none', 'skipped_no_recipe', null, 0);
    const failureId = await logFailure(env, service, ctx.cron, errMsg, ctx.payload, healLogId, ctx.occurredAt);
    await notifyPersistentErpFailure(env, service, failureId, errClass);
    return;
  }

  if (await isRateLimited(env, recipe)) {
    healLogId = await logHeal(env, recipe.id, service, errMsg, recipe.action_type, 'skipped_rate_limited', null, 0);
    const failureId = await logFailure(env, service, ctx.cron, errMsg, ctx.payload, healLogId, ctx.occurredAt);
    await notifyPersistentErpFailure(env, service, failureId, errClass);
    return;
  }

  // Try the heal action
  const t0 = Date.now();
  let result: 'success' | 'failed' = 'failed';
  let details: unknown = null;
  try {
    const config = JSON.parse(recipe.action_config || '{}');
    details = await executeHealAction(env, recipe.action_type, config);
    result = 'success';
  } catch (e) {
    details = { error: e instanceof Error ? e.message : String(e) };
    result = 'failed';
  }
  const durationMs = Date.now() - t0;

  healLogId = await logHeal(env, recipe.id, service, errMsg, recipe.action_type, result, details, durationMs);
  const failureId = await logFailure(env, service, ctx.cron, errMsg, ctx.payload, healLogId, ctx.occurredAt);
  if (result !== 'success') await notifyPersistentErpFailure(env, service, failureId, errClass);
}
