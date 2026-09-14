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
//   Body: { to, subject, text, from?, cc?, in_reply_to?, references? }
//   from must be a Resend-verified sender (apex / my. / legacy .ru) — enforced here.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { sendHumanResend, isAllowedHumanFrom, extractEmailAddr } from '../lib/resend-human';
import { mailRequestHash, withMailSendReceipt } from '../lib/mail-send-receipt';
import { loadDraftAttachments } from '../lib/mail-draft-files';
import type { RawAttachment } from '../lib/inbox-archive';

const route = new Hono<{ Bindings: Env }>();

const DEFAULT_FROM = 'sales@dasexperten.com';

// Thread tag: short, lowercase, no ambiguous characters. Length is a balance —
// long enough that two live threads never collide, short enough that a human
// reading sales+t7f3k2@dasexperten.com in a header does not feel watched.
const TAG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
function newThreadTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => TAG_ALPHABET[b % TAG_ALPHABET.length]).join('');
}

const replySchema = z.object({
  to: z.string().email().or(z.array(z.string().email()).min(1)),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(50_000),
  // Allow "Name <sales@…>" display form
  from: z.string().min(3).optional(),
  cc: z.string().email().or(z.array(z.string().email())).optional(),
  bcc: z.string().email().or(z.array(z.string().email())).optional(),
  draft_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  attachment_ids: z.array(z.string().uuid()).max(20).default([]),
  send_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  in_reply_to: z.string().optional(),
  // Ancestry of the letter being answered, oldest first. Optional: a first
  // contact has none, and a client that forgets it still threads by parent.
  references: z.array(z.string()).max(50).optional(),
  // Continue an existing tagged thread instead of opening a new one.
  reply_to_tag: z.string().regex(/^[a-z0-9]{4,16}$/).optional(),
}).refine((value) => !value.attachment_ids.length || Boolean(value.draft_id), 'Attachments require a saved draft');

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

  let attachments: RawAttachment[] = [];
  if (d.attachment_ids.length && d.draft_id) {
    try { attachments = await loadDraftAttachments(c.env, user.id, d.draft_id, d.attachment_ids); }
    catch { return c.json({ success: false, error: 'Attachments are missing or inaccessible. Reload the draft before sending.' }, 422); }
  }
  const requestHash = d.send_id ? await mailRequestHash(`${user.id}:${d.send_id}`) : undefined;
  const dispatch = () => sendHumanResend(c.env, {
    from,
    to: d.to,
    subject: d.subject,
    text: d.text,
    ...(d.cc !== undefined ? { cc: d.cc } : {}),
    ...(d.bcc !== undefined ? { bcc: d.bcc } : {}),
    attachments,
    ...(requestHash ? { idempotencyKey: `erp-reply/${requestHash}` } : {}),
    ...(d.in_reply_to !== undefined ? { in_reply_to: d.in_reply_to } : {}),
    ...(d.references !== undefined ? { references: d.references } : {}),
    // Every human reply gets a tag, first contact included: the thread we most
    // want to follow is the one that has not started yet.
    replyToTag: d.reply_to_tag || requestHash?.slice(0, 8) || newThreadTag(),
    origin: 'human',
    trigger: 'emailer-reply',
  });

  const result = requestHash ? await withMailSendReceipt(c.env, requestHash, d, dispatch) : await dispatch();

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
