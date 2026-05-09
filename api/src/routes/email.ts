import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const EMAILER_BRIDGE_URL = 'https://emailer-bridge.dasexperten.workers.dev/';

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

  let bridgeResponse: Response;
  try {
    bridgeResponse = await fetch(EMAILER_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return fail(c, 502, [{
      code: 'bridge_unreachable',
      message: 'Failed to reach emailer-bridge worker',
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
    const r = await fetch(EMAILER_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - probeStart;
    const bridgeOk = r.status < 500;

    return ok(c, {
      bridge_url: EMAILER_BRIDGE_URL,
      bridge_status: r.status,
      bridge_ok: bridgeOk,
      probe_method: 'POST dry-run',
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
