// =============================================================================
// Brand outbound via Resend + R2 Sent archive (Owner 2026-07-21).
//
//   POST /api/email/resend-send   — session: send + archive (compose / agents)
//   POST /api/email/archive-sent  — session or service: archive only (backfill)
//
// Emailer UI lists Inbox/<from>/sent via /api/email/mailboxes — not Gmail.
// Personal dasexperten@gmail.com is never CC'd or archived as brand Sent.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { sendHumanResend, extractEmailAddr } from '../lib/resend-human';
import { reconcileMailRecovery } from '../lib/mail-archive-recovery';

const route = new Hono<{ Bindings: Env }>();

// Protected maintenance, never sends mail. Recovery objects are retained:
// reconciliation is not permission to turn the overlay off while writers run.
route.post('/archive-recovery/reconcile', async (c) => {
  if (!c.env.EMAILER_SERVICE_SECRET || c.req.header('X-Emailer-Service-Secret') !== c.env.EMAILER_SERVICE_SECRET) return c.json({ success: false }, 401);
  const body = await c.req.json<{ cursor?: string }>().catch(() => ({} as { cursor?: string }));
  return c.json({ success: true, ...await reconcileMailRecovery(c.env, body.cursor) });
});

route.post('/archive-recovery/probe', async (c) => {
  if (!c.env.EMAILER_SERVICE_SECRET || c.req.header('X-Emailer-Service-Secret') !== c.env.EMAILER_SERVICE_SECRET) return c.json({ success: false }, 401);
  const key = `MailOutbox/diagnostic-recovery-${crypto.randomUUID()}.json`;
  const body = JSON.stringify({ purpose: 'archive recovery probe; no email', text: 'Проверка архива' });
  const first = await c.env.ARCHIVE.put(key, body, { onlyIf: { etagDoesNotMatch: '*' } });
  const read = await c.env.ARCHIVE.get(key);
  if (!first || !read || await read.text() !== body) throw new Error('Recovery probe readback failed');
  const stale = await c.env.ARCHIVE.put(key, 'must not write', { onlyIf: { etagDoesNotMatch: '*' } });
  if (stale !== null) throw new Error('Recovery probe conditional claim failed');
  await c.env.ARCHIVE.delete(key);
  if (await c.env.ARCHIVE.get(key)) throw new Error('Recovery probe delete failed');
  return c.json({ success: true, archive: c.env.MAIL_ARCHIVE_RECOVERY === 'old' ? 'recovery' : 'canonical', utf8: true, conditionalClaim: true, deleted: true, key });
});

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

async function requireUserOrService(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const svc = c.req.header('X-Emailer-Service-Secret');
  if (c.env.EMAILER_SERVICE_SECRET && svc && svc === c.env.EMAILER_SERVICE_SECRET) {
    return true;
  }
  // Agent-session service key for repair work (order backfill, customer recovery).
  const bf = c.req.header('X-Ingest-Secret');
  if (c.env.BACKFILL_SECRET && bf && bf === c.env.BACKFILL_SECRET) {
    return true;
  }
  // Витрина dasexperten.ru кладёт копию каждого отправленного письма
  // (Owner 2026-08-31): стучится тем же admin_token, которым ERP зовёт её
  // track.php — одна пара систем, один ключ в обе стороны. Без копии
  // письма «принят / оплата / отправлен» жили только у Resend, Emailer их не видел.
  const ru = c.req.header('X-Ru-Admin-Token');
  if (c.env.RU_ADMIN_TOKEN && ru && ru === c.env.RU_ADMIN_TOKEN) {
    return true;
  }
  const token = bearer(c);
  if (!token) return false;
  const user = await validateSession(c.env.DB, token);
  return !!user;
}

// Service callers supply Resend-style base64 attachments; preserve these at
// both send and archive boundaries instead of silently stripping them.
const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1),
  mimeType: z.string().optional(),
  encoding: z.literal('base64').default('base64'),
});
const attachmentsSchema = z.array(attachmentSchema).max(20).optional();

const sendSchema = z.object({
  from: z.string().min(3),
  to: z.string().email().or(z.array(z.string().email()).min(1)),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(100_000),
  html: z.string().max(200_000).optional(),
  cc: z.string().email().or(z.array(z.string().email())).optional(),
  bcc: z.string().email().or(z.array(z.string().email())).optional(),
  in_reply_to: z.string().optional(),
  reply_to_tag: z.string().regex(/^[a-z0-9]{4,16}$/).optional(),
  trigger: z.string().max(120).optional(),
  attachments: attachmentsSchema,
});

// Thread tag (Owner 2026-08-03 mechanism). Until 2026-08-09 this route issued none,
// so every letter an AGENT sent started life without a thread name and the only edge
// back to the answer was the subject line — which breaks the moment a counterparty
// replies in a language whose prefix we had not listed. Agents' letters now carry a
// tag exactly like the ones written in the Emailer UI.
const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function newThreadTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => TAG_ALPHABET[b % TAG_ALPHABET.length]).join('');
}

route.post('/resend-send', async (c) => {
  if (!(await requireUserOrService(c))) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON' }, 400);
  }

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'invalid body', issues: parsed.error.issues }, 422);
  }

  const d = parsed.data;
  const result = await sendHumanResend(c.env, {
    attachments: d.attachments,
    from: d.from,
    to: d.to,
    subject: d.subject,
    text: d.text,
    ...(d.html !== undefined ? { html: d.html } : {}),
    ...(d.cc !== undefined ? { cc: d.cc } : {}),
    ...(d.bcc !== undefined ? { bcc: d.bcc } : {}),
    ...(d.in_reply_to !== undefined ? { in_reply_to: d.in_reply_to } : {}),
    replyToTag: d.reply_to_tag || newThreadTag(),
    origin: 'human',
    trigger: d.trigger || 'emailer-resend-send',
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 502);
  }
  return c.json({
    success: true,
    messageId: result.messageId,
    archived: result.archived,
    ...(result.archiveError ? { archiveError: result.archiveError } : {}),
    mailbox: extractEmailAddr(d.from),
  });
});

const archiveOneSchema = z.object({
  from: z.string().min(3),
  to: z.string().email().or(z.array(z.string().email()).min(1)),
  subject: z.string().min(1),
  text: z.string().optional().default(''),
  html: z.string().optional(),
  messageId: z.string().min(1),
  cc: z.string().email().or(z.array(z.string().email())).optional(),
  trigger: z.string().optional(),
  in_reply_to: z.string().optional(),
  reply_to_tag: z.string().regex(/^[a-z0-9]{4,16}$/).optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1),
    content: z.string().min(1),
    encoding: z.literal('base64').default('base64'),
    mimeType: z.string().optional(),
    contentType: z.string().optional(),
  })).max(20).optional(),
});

const archiveBatchSchema = z.object({
  items: z.array(archiveOneSchema).min(1).max(200),
});

/** Backfill Resend-accepted sends into Emailer Sent (R2) without re-sending. */
route.post('/archive-sent', async (c) => {
  if (!(await requireUserOrService(c))) {
    return c.json({ success: false, error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'invalid JSON' }, 400);
  }

  // Accept either a single object or { items: [...] }
  const asBatch =
    body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
      ? archiveBatchSchema.safeParse(body)
      : archiveBatchSchema.safeParse({ items: [body] });

  if (!asBatch.success) {
    return c.json({ success: false, error: 'invalid body', issues: asBatch.error.issues }, 422);
  }

  let ok = 0;
  const errors: { messageId: string; error: string }[] = [];
  for (const item of asBatch.data.items) {
    const result = await sendHumanResend(c.env, {
      from: item.from,
      to: item.to,
      subject: item.subject,
      text: item.text || `(archived send ${item.messageId})`,
      ...(item.html !== undefined ? { html: item.html } : {}),
      ...(item.cc !== undefined ? { cc: item.cc } : {}),
      ...(item.in_reply_to !== undefined ? { in_reply_to: item.in_reply_to } : {}),
      ...(item.reply_to_tag !== undefined ? { replyToTag: item.reply_to_tag } : {}),
      ...(item.attachments !== undefined ? { attachments: item.attachments.map(file => ({ ...file, mimeType: file.mimeType || file.contentType })) } : {}),
      messageId: item.messageId,
      archive_only: true,
      origin: 'human',
      trigger: item.trigger || 'archive-backfill',
    });
    if (result.success && result.archived) ok++;
    else errors.push({ messageId: item.messageId, error: result.success ? (result.archiveError || 'Archive storage did not complete; retry archiving only') : result.error });
  }

  return c.json({ success: true, archived: ok, failed: errors.length, errors });
});

export default route;
