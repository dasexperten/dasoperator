// =============================================================================
// Cloudflare Email Sending service — transactional email from
// notify.dasexperten.com via the EMAIL Worker binding (send_email).
//
// This is a SEPARATE system from:
//   - EMAILER (Apps Script/Gmail bridge) — human-facing mail on the main
//     dasexperten.com mailboxes (sales@, support@, emea@, asean@, eurasia@).
//   - Cloudflare Email Routing on dasexperten.com — inbound forwarding only.
//
// Anything sent through this module MUST originate from an
// @notify.dasexperten.com address. Sending from a human-facing dasexperten.com
// mailbox is rejected — see assertAllowedSender().
// =============================================================================

import type { Env } from '../types';

export const SENDING_DOMAIN = 'notify.dasexperten.com';

export const SENDERS = {
  noReply: `no-reply@${SENDING_DOMAIN}`,
  notifications: `notifications@${SENDING_DOMAIN}`,
  orders: `orders@${SENDING_DOMAIN}`,
  forms: `forms@${SENDING_DOMAIN}`,
  system: `system@${SENDING_DOMAIN}`,
} as const;

export interface SendEmailParams {
  to: string | string[];
  from: string;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
}

export type SendEmailResult =
  | { success: true; messageId: string }
  | { success: false; error: string };

export class EmailValidationError extends Error {}

// ---------------------------------------------------------------------------
// Sender domain guard. Human-facing addresses (sales@, support@, emea@,
// asean@, eurasia@ — all @dasexperten.com) must never be used to send
// automated mail; only @notify.dasexperten.com is provisioned for that.
// ---------------------------------------------------------------------------
export function assertAllowedSender(from: string): void {
  const at = from.lastIndexOf('@');
  const domain = at >= 0 ? from.slice(at + 1).toLowerCase() : '';
  if (domain !== SENDING_DOMAIN) {
    throw new EmailValidationError(
      `Sender domain not allowed: "${from}". Automated sending is only permitted from @${SENDING_DOMAIN} ` +
      `addresses (e.g. ${SENDERS.noReply}). Human-facing addresses on dasexperten.com ` +
      `(sales@, support@, emea@, asean@, eurasia@) are reserved for people and must never send automated mail.`
    );
  }
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Recipients are logged, but only as domain-redacted markers — never store
// full email addresses (PII) in Worker logs alongside message content.
function redact(addr: string): string {
  const at = addr.indexOf('@');
  return at < 0 ? '***' : `${addr.slice(0, 1)}***@${addr.slice(at + 1)}`;
}

function logSendAttempt(fields: {
  recipient: string[];
  sender: string;
  subject: string;
  success: boolean;
  messageId?: string;
  error?: string;
}): void {
  // Structured, one-line JSON log. Deliberately excludes text/html bodies —
  // they may contain customer PII (names, order details, form content).
  console.log(JSON.stringify({
    scope: 'email.send',
    timestamp: new Date().toISOString(),
    recipient: fields.recipient.map(redact),
    sender: fields.sender,
    subject: fields.subject,
    success: fields.success,
    messageId: fields.messageId,
    error: fields.error,
  }));
}

// ---------------------------------------------------------------------------
// sendEmail — the one function that actually talks to the EMAIL binding.
// Every other helper in this module funnels through here.
// ---------------------------------------------------------------------------
export async function sendEmail(env: Env, params: SendEmailParams): Promise<SendEmailResult> {
  const recipients = toList(params.to);

  try {
    if (recipients.length === 0) throw new EmailValidationError('`to` is required');
    if (!params.from) throw new EmailValidationError('`from` is required');
    if (!params.subject) throw new EmailValidationError('`subject` is required');
    if (!params.text && !params.html) {
      throw new EmailValidationError('at least one of `text` or `html` is required');
    }

    assertAllowedSender(params.from);

    // Built via conditional spread (not plain keys) so unset optional fields
    // are omitted entirely rather than assigned `undefined` — the workers-types
    // SendEmail builder type doesn't accept explicit undefined under
    // exactOptionalPropertyTypes.
    const result = await env.EMAIL.send({
      from: params.from,
      to: recipients,
      subject: params.subject,
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.html !== undefined ? { html: params.html } : {}),
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
      ...(params.cc !== undefined ? { cc: params.cc } : {}),
      ...(params.bcc !== undefined ? { bcc: params.bcc } : {}),
    });

    logSendAttempt({
      recipient: recipients,
      sender: params.from,
      subject: params.subject,
      success: true,
      messageId: result.messageId,
    });

    return { success: true, messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSendAttempt({
      recipient: recipients,
      sender: params.from,
      subject: params.subject || '(no subject)',
      success: false,
      error: message,
    });
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// sendTestEmail — used by POST /api/email/test
// ---------------------------------------------------------------------------
export async function sendTestEmail(env: Env, to: string): Promise<SendEmailResult> {
  return sendEmail(env, {
    to,
    from: SENDERS.noReply,
    subject: 'Das Operator Email Sending Test',
    text: 'This is a test email from Das Operator via Cloudflare Email Sending.',
    html: '<h1>Das Operator Email Sending Test</h1><p>This is a test email from Das Operator via Cloudflare Email Sending.</p>',
  });
}

// ---------------------------------------------------------------------------
// sendLeadNotification — website/CRM lead capture → internal team.
// `to` is the internal recipient(s) (e.g. the sales team inbox); it is NOT
// hardcoded here since which inbox owns leads is a business decision made
// by the caller/route, not this module.
// ---------------------------------------------------------------------------
export interface LeadNotificationParams {
  to: string | string[];
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  message: string;
  source?: string; // e.g. "dasexperten.com contact form"
}

export async function sendLeadNotification(env: Env, params: LeadNotificationParams): Promise<SendEmailResult> {
  const rows: Array<[string, string]> = [
    ['Name', params.name || '—'],
    ['Email', params.email || '—'],
    ['Phone', params.phone || '—'],
    ['Company', params.company || '—'],
    ['Source', params.source || '—'],
  ];

  const textRows = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const htmlRows = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('');

  return sendEmail(env, {
    to: params.to,
    from: SENDERS.forms,
    replyTo: params.email,
    subject: 'New Das Experten inquiry received',
    text: `New inquiry received.\n\n${textRows}\n\nMessage:\n${params.message}`,
    html: `<h2>New Das Experten inquiry received</h2><table>${htmlRows}</table><p><strong>Message:</strong></p><p>${params.message}</p>`,
  });
}

// ---------------------------------------------------------------------------
// sendFormSubmissionNotification — generic website/ERP form submission.
// Same "New Das Experten inquiry received" template as sendLeadNotification,
// but for arbitrary form field sets rather than the fixed lead shape.
// ---------------------------------------------------------------------------
export interface FormSubmissionNotificationParams {
  to: string | string[];
  formName: string;
  fields: Record<string, string>;
  submitterEmail?: string;
}

export async function sendFormSubmissionNotification(
  env: Env,
  params: FormSubmissionNotificationParams
): Promise<SendEmailResult> {
  const entries = Object.entries(params.fields);
  const textRows = entries.map(([k, v]) => `${k}: ${v}`).join('\n');
  const htmlRows = entries.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join('');

  return sendEmail(env, {
    to: params.to,
    from: SENDERS.forms,
    replyTo: params.submitterEmail,
    subject: 'New Das Experten inquiry received',
    text: `Form submitted: ${params.formName}\n\n${textRows}`,
    html: `<h2>New Das Experten inquiry received</h2><p>Form: ${params.formName}</p><table>${htmlRows}</table>`,
  });
}

// ---------------------------------------------------------------------------
// sendOrderNotification — automatic order-related notifications.
// ---------------------------------------------------------------------------
export interface OrderNotificationParams {
  to: string | string[];
  orderId: string;
  status?: string;
  message: string;
}

export async function sendOrderNotification(env: Env, params: OrderNotificationParams): Promise<SendEmailResult> {
  const statusLine = params.status ? ` — status: ${params.status}` : '';

  return sendEmail(env, {
    to: params.to,
    from: SENDERS.orders,
    subject: 'Das Experten order update',
    text: `Order ${params.orderId}${statusLine}\n\n${params.message}`,
    html: `<h2>Das Experten order update</h2><p>Order <strong>${params.orderId}</strong>${statusLine}</p><p>${params.message}</p>`,
  });
}

// ---------------------------------------------------------------------------
// sendSystemNotification — internal technical/system alerts.
// (Third template from the spec; rounds out the three sender identities —
// forms@, orders@, system@ — alongside no-reply@ used only for the test email.)
// ---------------------------------------------------------------------------
export interface SystemNotificationParams {
  to: string | string[];
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export async function sendSystemNotification(env: Env, params: SystemNotificationParams): Promise<SendEmailResult> {
  const severity = params.severity || 'info';

  return sendEmail(env, {
    to: params.to,
    from: SENDERS.system,
    subject: 'Das Operator system notification',
    text: `[${severity.toUpperCase()}] ${params.message}`,
    html: `<h2>Das Operator system notification</h2><p><strong>${severity.toUpperCase()}</strong></p><p>${params.message}</p>`,
  });
}
