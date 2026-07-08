// =============================================================================
// Outbound transactional email routes — Cloudflare Email Sending (Beta) on
// notify.dasexperten.com. Separate from routes/email.ts (which talks to the
// EMAILER Apps Script/Gmail bridge for human-facing dasexperten.com mail).
//
//   POST /api/email/test — admin-only smoke test, sends a fixed message from
//                          no-reply@notify.dasexperten.com.
//
// Response shape here intentionally does NOT use the app-wide ok()/fail()
// envelope — the spec for this endpoint calls for a bare
// { success, messageId } / { success, error } body.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { sendTestEmail, SENDERS } from '../services/email';

const KNOWN_SENDERS = new Set<string>(Object.values(SENDERS));

const route = new Hono<{ Bindings: Env }>();

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

// Admin gate: either a valid session belonging to an admin user, or the
// shared X-Admin-Email-Test-Secret header (for ops/curl testing without a
// logged-in session). Set the secret via: wrangler secret put ADMIN_EMAIL_TEST_SECRET
async function isAuthorized(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const secretHeader = c.req.header('X-Admin-Email-Test-Secret');
  if (c.env.ADMIN_EMAIL_TEST_SECRET && secretHeader === c.env.ADMIN_EMAIL_TEST_SECRET) {
    return true;
  }

  const token = bearer(c);
  if (!token) return false;
  const user = await validateSession(c.env.DB, token);
  return !!user && user.role === 'admin';
}

route.post('/test', async (c) => {
  if (!(await isAuthorized(c))) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  let body: { to?: unknown; from?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Request body must be valid JSON' }, 400);
  }

  const to = typeof body?.to === 'string' ? body.to.trim() : '';
  if (!to) {
    return c.json({ success: false, error: '`to` is required' }, 422);
  }

  // Optional sender override for smoke-testing each provisioned identity —
  // restricted to the known SENDERS set (not arbitrary @notify.dasexperten.com
  // local-parts) since this endpoint's job is to verify the 5 real mailboxes.
  let from: string | undefined;
  if (typeof body?.from === 'string' && body.from.trim()) {
    from = body.from.trim();
    if (!KNOWN_SENDERS.has(from)) {
      return c.json({
        success: false,
        error: `\`from\` must be one of: ${[...KNOWN_SENDERS].join(', ')}`,
      }, 422);
    }
  }

  const result = await sendTestEmail(c.env, to, from);
  if (!result.success) {
    return c.json(result, 502);
  }
  return c.json(result, 200);
});

export default route;
