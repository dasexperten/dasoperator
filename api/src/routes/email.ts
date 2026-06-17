import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const email = new Hono<{ Bindings: Env }>();

const sendSchema = z.object({
  action: z.enum(['send', 'reply', 'reply_all']).default('send'),
  recipient: z.string().email().optional(),
  thread_id: z.string().optional(),
  subject: z.string().min(1).optional(),
  body_plain: z.string().optional(),
  body_html: z.string().optional(),
  attachments: z.array(z.string()).optional().default([]),
  context: z.string().optional(),
  draft_only: z.boolean().optional().default(false),
}).refine(
  (data) => data.body_plain || data.body_html,
  { message: 'At least one of body_plain or body_html must be provided' }
).refine(
  (data) => {
    if (data.action === 'send') return !!data.recipient;
    if (data.action === 'reply' || data.action === 'reply_all') return !!data.thread_id;
    return false;
  },
  { message: 'send requires recipient; reply/reply_all requires thread_id' }
);

email.post('/send', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Request body must be valid JSON' }]);
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Request body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  // Use EMAILER service binding instead of *.workers.dev public URL.
  // Cloudflare blocks Worker→same-account-Worker via the public URL with
  // error 1042 — service bindings bypass that loop check.
  let bridgeResponse: Response;
  try {
    bridgeResponse = await c.env.EMAILER.fetch(new Request('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(60_000),
    }));
  } catch (err) {
    return fail(c, 502, [{
      code: 'bridge_unreachable',
      message: 'Failed to reach emailer-bridge worker via EMAILER binding',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  let bridgePayload: unknown;
  try {
    bridgePayload = await bridgeResponse.json();
  } catch {
    return fail(c, 502, [{
      code: 'bridge_invalid_response',
      message: `emailer-bridge returned non-JSON (HTTP ${bridgeResponse.status})`,
    }]);
  }

  if (!bridgeResponse.ok) {
    return fail(c, 502, [{
      code: 'bridge_error',
      message: `emailer-bridge returned HTTP ${bridgeResponse.status}`,
      details: { bridge_response: bridgePayload },
    }]);
  }

  return ok(c, bridgePayload, ['Email forwarded to emailer-bridge']);
});

// =============================================================================
// GET /api/email/history
// Fetch sent emails via Apps Script find action.
// Query param: query (Gmail search syntax, default: newer_than:30d)
// =============================================================================
email.get('/export/status', async (c) => {
  const cursor = await c.env.CACHE.get('email-harvest:cursor');
  const total = await c.env.CACHE.get('email-harvest:count');
  const done = await c.env.CACHE.get('email-harvest:done');
  return ok(c, { cursor: Number(cursor || 0), harvested: Number(total || 0), done: done === '1' });
});

email.post('/export/start', async (c) => {
  await c.env.CACHE.put('email-harvest:cursor', '0');
  await c.env.CACHE.put('email-harvest:count', '0');
  await c.env.CACHE.delete('email-harvest:done');
  return ok(c, { reset: true, message: 'harvest will run on the next minute tick' });
});

email.post('/export', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const payload = {
    action: 'export',
    query: typeof body.query === 'string' ? body.query : 'in:anywhere',
    start: parseInt(body.start, 10) || 0,
    max: Math.min(50, Math.max(1, parseInt(body.max, 10) || 25)),
    bodies: body.bodies !== false,
  };
  let r: Response;
  try {
    r = await c.env.EMAILER.fetch(new Request('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    }));
  } catch (err) {
    return fail(c, 502, [{ code: 'bridge_unreachable', message: String(err) }]);
  }
  const txt = await r.text();
  let j: unknown;
  try { j = JSON.parse(txt); } catch {
    return fail(c, 502, [{ code: 'bridge_invalid', message: `non-JSON (HTTP ${r.status}): ${txt.slice(0,300)}` }]);
  }
  return ok(c, j);
});

email.get('/history', async (c) => {
  const query = c.req.query('query') || 'newer_than:30d';
  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  try {
    const bridgeResponse = await c.env.EMAILER.fetch(new Request('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'find',
        query,
        limit,
      }),
      signal: AbortSignal.timeout(30_000),
    }));

    let bridgePayload: unknown;
    try {
      bridgePayload = await bridgeResponse.json();
    } catch {
      return fail(c, 502, [{
        code: 'bridge_invalid_response',
        message: `emailer-bridge returned non-JSON (HTTP ${bridgeResponse.status})`,
      }]);
    }

    if (!bridgeResponse.ok) {
      return fail(c, 502, [{
        code: 'bridge_error',
        message: `emailer-bridge returned HTTP ${bridgeResponse.status}`,
        details: { bridge_response: bridgePayload },
      }]);
    }

    return ok(c, bridgePayload, ['Email history fetched']);
  } catch (err) {
    return fail(c, 502, [{
      code: 'bridge_unreachable',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

// =============================================================================
// GET /api/email/rules
// List all email forwarding/deletion rules for the current user.
// =============================================================================
email.get('/rules', async (c) => {
  try {
    const user = c.get('user') as { id: string } | undefined;
    const userId = user?.id || 'default';

    const { results } = await c.env.DB.prepare(
      'SELECT id, rule_type, pattern, action, target, enabled, created_at FROM email_rules WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(userId).all();

    return ok(c, { rules: results }, ['Email rules fetched']);
  } catch (err) {
    return fail(c, 500, [{
      code: 'db_error',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

// =============================================================================
// POST /api/email/rules
// Create a new email rule.
// =============================================================================
const ruleSchema = z.object({
  rule_type: z.enum(['forward', 'auto_delete', 'archive']),
  pattern: z.string().min(1),
  action: z.string().optional(),
  target: z.string().optional(),
  enabled: z.boolean().default(true),
}).refine(
  (data) => {
    if (data.rule_type === 'forward') return !!data.target;
    return true;
  },
  { message: 'forward rules require a target email address' }
);

email.post('/rules', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Request body must be valid JSON' }]);
  }

  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Request body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  try {
    const user = c.get('user') as { id: string } | undefined;
    const userId = user?.id || 'default';

    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);

    await c.env.DB.prepare(
      'INSERT INTO email_rules (id, user_id, rule_type, pattern, action, target, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id,
      userId,
      parsed.data.rule_type,
      parsed.data.pattern,
      parsed.data.action || null,
      parsed.data.target || null,
      parsed.data.enabled ? 1 : 0,
      now
    ).run();

    return ok(c, { id, ...parsed.data }, ['Email rule created']);
  } catch (err) {
    return fail(c, 500, [{
      code: 'db_error',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

// =============================================================================
// DELETE /api/email/rules/:id
// Delete an email rule.
// =============================================================================
email.delete('/rules/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const user = c.get('user') as { id: string } | undefined;
    const userId = user?.id || 'default';

    const { success } = await c.env.DB.prepare(
      'DELETE FROM email_rules WHERE id = ? AND user_id = ?'
    ).bind(id, userId).run();

    if (!success) {
      return fail(c, 404, [{
        code: 'not_found',
        message: 'Email rule not found',
      }]);
    }

    return ok(c, { deleted: true }, ['Email rule deleted']);
  } catch (err) {
    return fail(c, 500, [{
      code: 'db_error',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

// =============================================================================
// GET /api/email/health
// Probes emailer-bridge reachability via dry-run POST.
//
// Sends a minimal POST with intentionally invalid payload. emailer-bridge
// returns 4xx if alive (validation rejected) or 5xx/network if down.
//
// bridge_ok semantics:
//   200..299 → true  (bridge processed something)
//   400..499 → true  (bridge alive, rejected probe — expected)
//   500..599 → false (bridge broken)
//   network  → false (caught below, returns 502 on this endpoint)
// =============================================================================
email.get('/health', async (c) => {
  const probeStart = Date.now();
  try {
    const r = await c.env.EMAILER.fetch(new Request('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.timeout(10_000),
    }));
    const latency = Date.now() - probeStart;
    const bridgeOk = r.status < 500;

    return ok(c, {
      bridge_binding: 'EMAILER (service binding)',
      bridge_status: r.status,
      bridge_ok: bridgeOk,
      probe_method: 'POST dry-run via env.EMAILER.fetch',
      latency_ms: latency,
    });
  } catch (err) {
    return fail(c, 502, [{
      code: 'bridge_unreachable',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

export default email;
