// =============================================================================
// Human-facing outbound reply — Resend.
//
// The Emailer UI reads inbound mail archived from Cloudflare Email Routing.
// This endpoint is the *reply* path: it sends a real person-to-person email
// via Resend and archives a copy as a `sent` record next to the thread, so
// the conversation stays visible in the same R2 archive the reader lists.
//
// v4 (2026-07-11): apex dasexperten.com is Resend-verified (DKIM aligned, no
// "via" banner) — official human senders live there. my.dasexperten.com stays
// the system-sender domain; send.dasexperten.ru kept for legacy .ru replies.
//
// Cloudflare handles inbound; Resend handles this one outbound hop. The
// RESEND_API_KEY is a restricted (send-only) key stored as a Worker secret.
//
//   POST /api/email/reply
//   Body: { to, subject, text, from?, cc?, in_reply_to? }
//   from must be a Resend-verified sender (apex / my. / legacy .ru) — enforced here.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { sendHumanResend, isAllowedHumanFrom, extractEmailAddr } from '../lib/resend-human';

const route = new Hono<{ Bindings: Env }>();

const DEFAULT_FROM = 'sales@dasexperten.com';

const replySchema = z.object({
  to: z.string().email().or(z.array(z.string().email()).min(1)),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(50_000),
  // Allow "Name <sales@…>" display form
  from: z.string().min(3).optional(),
  cc: z.string().email().or(z.array(z.string().email())).optional(),
  in_reply_to: z.string().optional(),
});

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

route.post('/reply', async (c) => {
  const token = bearer(c);
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return c.json({ success: false, error: 'unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON' }, 400);
  }

  const parsed = replySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'invalid body', issues: parsed.error.issues }, 422);
  }
  const d = parsed.data;
  const from = d.from ?? DEFAULT_FROM;

  if (!isAllowedHumanFrom(from)) {
    return c.json(
      {
        success: false,
        error: `from is not a verified brand sender (got ${from})`,
      },
      422,
    );
  }

  const result = await sendHumanResend(c.env, {
    from,
    to: d.to,
    subject: d.subject,
    text: d.text,
    ...(d.cc !== undefined ? { cc: d.cc } : {}),
    ...(d.in_reply_to !== undefined ? { in_reply_to: d.in_reply_to } : {}),
    origin: 'human',
    trigger: 'emailer-reply',
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 502);
  }

  return c.json({
    success: true,
    messageId: result.messageId,
    archived: result.archived,
    mailbox: extractEmailAddr(from),
  });
});

export default route;
