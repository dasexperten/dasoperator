// =============================================================================
// Human-facing outbound via Resend + R2 Inbox archive (Owner 2026-07-21).
//
// Boss pays for Resend and looks at Emailer Sent (R2 Inbox/<from>/sent/).
// Never archive to dasexperten@gmail.com. Never require Gmail for visibility.
// =============================================================================

import type { Env } from '../types';
import { archiveEmail } from './inbox-archive';
import { MAILBOX_REGISTRY } from './mailbox-registry';

/** Apex addresses allowed for human/agent brand mail (Resend-verified). */
export const HUMAN_SENDERS = new Set([
  ...MAILBOX_REGISTRY.filter((m) => m.inbound === 'worker').map((m) => m.address.toLowerCase()),
  // Core human From set (overlap with registry; keep explicit for safety)
  'sales@dasexperten.com',
  'support@dasexperten.com',
  'emea@dasexperten.com',
  'eurasia@dasexperten.com',
  'asean@dasexperten.com',
  'marketing@dasexperten.com',
  'partnerships@dasexperten.com',
  'hello@dasexperten.com',
  'orders@dasexperten.com',
  'roberta@dasexperten.com',
  'julian@dasexperten.com',
  'jurgen@dasexperten.com',
  'lauda@dasexperten.com',
  'marika@dasexperten.com',
  'maria@dasexperten.com',
  'valentina@dasexperten.com',
  'justina@dasexperten.com',
  'tamara@dasexperten.com',
]);

export function extractEmailAddr(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  const addr = (m?.[1] ?? raw).trim().toLowerCase();
  return addr;
}

export function isAllowedHumanFrom(from: string): boolean {
  const addr = extractEmailAddr(from);
  if (!addr || addr === 'dasexperten@gmail.com' || addr === 'dr.badalyan@dasexperten.com') {
    return false;
  }
  return HUMAN_SENDERS.has(addr) || /@(my\.dasexperten\.com)$/i.test(addr);
}

/** Strip personal Gmail from to/cc/bcc for brand sends (Owner 2026-07-21). */
export function stripPersonalGmail(list: string[] | undefined): string[] | undefined {
  if (!list?.length) return list;
  const filtered = list.filter((a) => extractEmailAddr(a) !== 'dasexperten@gmail.com');
  return filtered.length ? filtered : undefined;
}

export interface HumanSendParams {
  from: string; // may be "Name <sales@dasexperten.com>"
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  in_reply_to?: string;
  origin?: 'human' | 'auto';
  trigger?: string;
  /** When true, skip Resend and only write R2 archive (backfill). Requires messageId. */
  archive_only?: boolean;
  messageId?: string;
}

export type HumanSendResult =
  | { success: true; messageId: string; archived: boolean }
  | { success: false; error: string };

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Send human brand mail via Resend and archive under Inbox/<from-addr>/sent/.
 */
export async function sendHumanResend(env: Env, params: HumanSendParams): Promise<HumanSendResult> {
  const fromRaw = params.from.trim();
  if (!isAllowedHumanFrom(fromRaw)) {
    return {
      success: false,
      error: `from not allowed for brand Resend (got ${fromRaw}). Use sales@ / agent@ / department@ — never personal Gmail.`,
    };
  }

  const fromAddr = extractEmailAddr(fromRaw);
  const toList = asList(params.to).filter((a) => extractEmailAddr(a) !== 'dasexperten@gmail.com');
  const ccList = stripPersonalGmail(asList(params.cc));
  const bccList = stripPersonalGmail(asList(params.bcc));

  if (!toList.length) {
    return { success: false, error: '`to` required (and must not be only personal Gmail)' };
  }
  if (!params.subject?.trim()) return { success: false, error: '`subject` required' };
  if (!params.text?.trim() && !params.html?.trim()) {
    return { success: false, error: '`text` or `html` required' };
  }

  let messageId = params.messageId;

  if (!params.archive_only) {
    if (!env.RESEND_API_KEY) {
      return { success: false, error: 'RESEND_API_KEY not configured' };
    }
    const resendBody: Record<string, unknown> = {
      from: fromRaw,
      to: toList,
      subject: params.subject,
      text: params.text,
    };
    if (params.html) resendBody.html = params.html;
    if (ccList?.length) resendBody.cc = ccList;
    if (bccList?.length) resendBody.bcc = bccList;
    if (params.in_reply_to) {
      resendBody.headers = {
        'In-Reply-To': params.in_reply_to,
        References: params.in_reply_to,
      };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resendBody),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as { id?: string; message?: string };
      if (!res.ok || !json.id) {
        return { success: false, error: json.message || `Resend HTTP ${res.status}` };
      }
      messageId = json.id;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!messageId) {
    return { success: false, error: 'messageId required for archive_only' };
  }

  await archiveEmail(env, 'sent', fromAddr, {
    from: fromRaw,
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: params.subject,
    text: params.text,
    html: params.html,
    messageId,
    threadId: params.in_reply_to,
    origin: params.origin ?? 'human',
    trigger: params.trigger,
  });

  return { success: true, messageId, archived: true };
}
