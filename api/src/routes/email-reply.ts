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
import { archiveEmail } from '../lib/inbox-archive';

const route = new Hono<{ Bindings: Env }>();

// Only Resend-verified senders.
// - Apex dasexperten.com (verified 2026-07-11): the six official human
//   addresses — replies to counterparties go from these.
// - my.dasexperten.com: system senders (Workers) — allowed for completeness.
// - send.dasexperten.ru: legacy .ru fallback.
const APEX_SENDERS = new Set([
  'sales@dasexperten.com',
  'support@dasexperten.com',
  'emea@dasexperten.com',
  'eurasia@dasexperten.com',
  'asean@dasexperten.com',
  'dr.badalyan@dasexperten.com',
]);
const ALLOWED_FROM = /@(my\.dasexperten\.com|(send\.)?dasexperten\.ru)$/i;
const isAllowedFrom = (addr: string): boolean =>
  APEX_SENDERS.has(addr.toLowerCase()) || ALLOWED_FROM.test(addr);
const DEFAULT_FROM = 'sales@dasexperten.com';

const replySchema = z.object({
  to: z.string().email().or(z.array(z.string().email()).min(1)),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(50_000),
  from: z.string().email().optional(),
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
  // Auth: any logged-in user may reply.
  const token = bearer(c);
  const user = token ? await validateSession(c.env.DB, token) : null;
  if (!user) return c.json({ success: false, error: 'unauthorized' }, 401);

  if (!c.env.RESEND_API_KEY) {
    return c.json({ success: false, error: 'RESEND_API_KEY not configured' }, 500);
  }

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
  if (!isAllowedFrom(from)) {
    return c.json(
      {
        success: false,
        error: `from is not a verified sender (got ${from})`,
        allowed: [...APEX_SENDERS, '*@my.dasexperten.com', '*@send.dasexperten.ru'],
      },
      422,
    );
  }

  const toList = Array.isArray(d.to) ? d.to : [d.to];
  const ccList = d.cc ? (Array.isArray(d.cc) ? d.cc : [d.cc]) : undefined;

  // Send via Resend.
  const resendBody: Record<string, unknown> = {
    from,
    to: toList,
    subject: d.subject,
    text: d.text,
  };
  if (ccList) resendBody.cc = ccList;
  if (d.in_reply_to) {
    resendBody.headers = {
      'In-Reply-To': d.in_reply_to,
      References: d.in_reply_to,
    };
  }

  let resendJson: { id?: string; message?: string; name?: string };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendBody),
      signal: AbortSignal.timeout(30_000),
    });
    resendJson = await res.json();
    if (!res.ok || !resendJson.id) {
      return c.json(
        { success: false, error: resendJson.message || `Resend HTTP ${res.status}` },
        502,
      );
    }
  } catch (err) {
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  // Archive the outbound copy as `sent`, keyed on the From mailbox — mirrors
  // how inbound is keyed on the To mailbox, so both appear in one archive.
  await archiveEmail(c.env, 'sent', from, {
    from,
    to: toList,
    cc: ccList,
    subject: d.subject,
    text: d.text,
    messageId: resendJson.id,
    threadId: d.in_reply_to,
  });

  return c.json({ success: true, messageId: resendJson.id });
});

export default route;
