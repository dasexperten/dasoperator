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
  // maria@ removed 2026-08-30 (Owner R6): the address is retired and its
  // routing rule is disabled, so a reply to it would land nowhere (§6.0e).
  // Marika sends from brand@ (her primary) or marika@.
  'valentina@dasexperten.com',
  'justina@dasexperten.com',
  'tamara@dasexperten.com',
  'mina@dasexperten.com',
  // Витрина dasexperten.ru — домен verified в Resend, но inbound: 'none'
  // (нет MX), поэтому фильтр по inbound === 'worker' их не поднимает.
  // Перечислены явно, иначе Emailer откажет в отправке.
  'zakaz@dasexperten.ru',
  'oplata@dasexperten.ru',
  'dostavka@dasexperten.ru',
  // Фактический отправитель всех писем витрины (mail.php, cfg.from) —
  // «принят / оплата получена / отправлен» уходят с него, и покупатели
  // отвечают на него. Нужен для archive_only-копий (Owner 2026-08-31).
  'shop@dasexperten.ru',
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
  /** Full ancestry, oldest first. Gmail and Outlook build the tree from
   *  References, not from In-Reply-To — a chain of one collapses long threads
   *  into loose letters once more than two people answer. */
  references?: string[] | undefined;
  /** Thread tag to publish in Reply-To as box+<tag>@domain. Their answer comes
   *  back carrying it, which is the only edge that does not depend on what the
   *  provider decides to put in Message-ID. */
  replyToTag?: string | undefined;
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
 * A body that is empty or a known backfill placeholder. Length is deliberately
 * NOT a factor: "Спасибо, принято" is a real letter, and a human replying from
 * the Emailer reply bar writes short lines by design (Owner 2026-07-29).
 */
export function isPlaceholderText(text: string | undefined): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (/Archived into Emailer Sent from Resend id/i.test(t)) return true;
  if (/^\(archived send /i.test(t)) return true;
  if (/Original body was partnership\/education outreach/i.test(t)) return true;
  return false;
}

/**
 * Placeholder, empty, or suspiciously thin. Used ONLY on the archive_only /
 * backfill path, where a short body means the original letter was never stored
 * and we should hydrate it from Resend. Never gate a live send on this — see
 * isPlaceholderText.
 */
export function isThinOrStubText(text: string | undefined): boolean {
  const t = (text || '').trim();
  if (t.length < 40) return true;
  return isPlaceholderText(t);
}

/**
 * Pull body from Resend by id. Attachments stay on Resend — we only need text/html
 * (links in body are enough; no binary attachment storage in Emailer).
 */
export async function fetchResendEmailBody(
  env: Env,
  messageId: string,
): Promise<{ text?: string; html?: string; subject?: string; from?: string; to?: string[] } | null> {
  if (!env.RESEND_API_KEY || !messageId) return null;
  try {
    const res = await fetch(`https://api.resend.com/emails/${messageId}`, {
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': 'dasoperator-emailer/1.0',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      text?: string | null;
      html?: string | null;
      subject?: string;
      from?: string;
      to?: string[];
    };
    return {
      ...(j.text ? { text: j.text } : {}),
      ...(j.html ? { html: j.html } : {}),
      ...(j.subject ? { subject: j.subject } : {}),
      ...(j.from ? { from: j.from } : {}),
      ...(j.to ? { to: j.to } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Send human brand mail via Resend and archive under Inbox/<from-addr>/sent/.
 *
 * Emailer always gets full **text** (and html if present). Attachments are not
 * re-uploaded to R2 — keep files on Resend / public links inside the body.
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
  if (!params.text?.trim() && !params.html?.trim() && !params.archive_only) {
    return { success: false, error: '`text` or `html` required' };
  }

  let messageId = params.messageId;
  let text = params.text || '';
  let html = params.html;

  if (!params.archive_only) {
    if (!env.RESEND_API_KEY) {
      return { success: false, error: 'RESEND_API_KEY not configured' };
    }
    // Live send requires a real body — empty or placeholder only. A short human
    // reply is a real body and must go out (Owner 2026-07-29).
    if (isPlaceholderText(text) && !html?.trim()) {
      return { success: false, error: '`text` is empty or a placeholder — write the letter body' };
    }
    const resendBody: Record<string, unknown> = {
      from: fromRaw,
      to: toList,
      subject: params.subject,
      text: text || '(see html)',
    };
    if (html) resendBody.html = html;
    // Reply-To names the thread, not just the box. Sent before the letter
    // leaves, because there is no second chance to label it afterwards.
    if (params.replyToTag) {
      const at = fromAddr.lastIndexOf('@');
      if (at > 0) {
        resendBody.reply_to = `${fromAddr.slice(0, at)}+${params.replyToTag}@${fromAddr.slice(at + 1)}`;
      }
    }
    if (ccList?.length) resendBody.cc = ccList;
    if (bccList?.length) resendBody.bcc = bccList;
    if (params.in_reply_to) {
      // References = every ancestor we know, oldest first, parent last.
      // Deduplicated because a chain that repeats an id makes some clients
      // start a fresh thread — the exact failure we are fixing.
      const chain: string[] = [];
      for (const id of [...(params.references || []), params.in_reply_to]) {
        const trimmed = (id || '').trim();
        if (trimmed && !chain.includes(trimmed)) chain.push(trimmed);
      }
      resendBody.headers = {
        'In-Reply-To': params.in_reply_to,
        References: chain.join(' '),
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

  // Backfill / thin stubs: hydrate full body from Resend so Emailer shows real text.
  // Attachments remain on Resend; we only pull text/html.
  if (isThinOrStubText(text) && !html?.trim()) {
    const hydrated = await fetchResendEmailBody(env, messageId);
    if (hydrated?.text) text = hydrated.text;
    if (hydrated?.html) html = hydrated.html;
  }

  // Backfill may still refuse: an archive_only row with no body is worthless.
  // A live send must NEVER be reported as failed here — the letter has already
  // left the building; a thin archive row is a lesser evil than a false error.
  if (params.archive_only && isThinOrStubText(text) && !html?.trim()) {
    return {
      success: false,
      error: `cannot archive ${messageId}: no full body (stub/empty) and Resend hydrate failed`,
    };
  }

  await archiveEmail(env, 'sent', fromAddr, {
    from: fromRaw,
    to: toList,
    cc: ccList,
    bcc: bccList,
    subject: params.subject,
    text: text || undefined,
    html: html,
    messageId,
    threadId: params.in_reply_to,
    ...(params.replyToTag ? { plusTag: params.replyToTag } : {}),
    origin: params.origin ?? 'human',
    trigger: params.trigger,
  });

  // Also index under partnerships@ when it was CC'd so GEO team mailbox sees the send.
  if (ccList?.some((a) => extractEmailAddr(a) === 'partnerships@dasexperten.com') && fromAddr !== 'partnerships@dasexperten.com') {
    await archiveEmail(env, 'sent', 'partnerships@dasexperten.com', {
      from: fromRaw,
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject: params.subject,
      text: text || undefined,
      html: html,
      messageId,
      threadId: params.in_reply_to,
      ...(params.replyToTag ? { plusTag: params.replyToTag } : {}),
      origin: params.origin ?? 'human',
      trigger: (params.trigger || 'emailer') + '+cc-partnerships',
    });
  }

  return { success: true, messageId, archived: true };
}
