// =============================================================================
// Inbound email handler — Cloudflare Email Routing → Worker.
//
// Wired to dasexperten.com addresses (sales@, support@, eurasia@, emea@,
// asean@, …) via Email Routing rules that "Send to Worker: dasoperator-api".
// Every message Cloudflare accepts for one of those addresses is delivered
// here as a ForwardableEmailMessage. We parse the raw MIME and archive it as
// a `received` record in the same R2 layout the outbound path uses, so the
// Emailer UI shows inbound mail right next to the notify.* outbound copies —
// no schema divergence, no separate inbox store.
//
// This is the *inbound* twin of the notify.dasexperten.com *outbound* archive.
// The two are different Cloudflare products (Email Routing vs Email Sending)
// but land in one bucket keyed by mailbox address, so the reader in
// email-archive.ts lists both directions transparently.
// =============================================================================

import PostalMime from 'postal-mime';
import { archiveEmail } from './inbox-archive';
import type { MailAuth } from './inbox-archive';
import { isOwnerGmailOnly, OWNER_PERSONAL_ADDRESS, OWNER_GMAIL_FORWARD } from './mailbox-registry';
import type { Env } from '../types';

// ForwardableEmailMessage is a global type from @cloudflare/workers-types.
//
// Owner 2026-07-17: dr.badalyan@dasexperten.com is CF-forwarded to
// dasexperten@gmail.com and must NOT be archived into R2 or shown under
// Agents in /emailer. See docs/EMAILER_AGENTS_DEPARTMENTS.md.

function headerList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// =============================================================================
// Sender authentication (HARD_RULES §6.0b, Owner 2026-08-01).
//
// Cloudflare writes Authentication-Results on inbound. We stored `parsed.from`
// and dropped the verdict — so a forged From was indistinguishable from a real
// one. That is tolerable for ordinary mail and NOT tolerable now: a letter from
// the Owner's three addresses is an instruction that goes straight into an
// agent's playbook. The lock has to exist before the privilege does.
//
// Fail closed: anything we cannot positively verify is 'none', never a pass.
// =============================================================================
function verdictFor(header: string, method: 'dmarc' | 'spf' | 'dkim'): 'pass' | 'fail' | 'none' {
  // e.g. "... dmarc=pass header.from=gmail.com; spf=fail ..."
  const m = new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, 'i').exec(header);
  const v = m?.[1]?.toLowerCase();
  if (v === 'pass') return 'pass';
  if (v === 'fail' || v === 'softfail' || v === 'permerror' || v === 'temperror') return 'fail';
  return 'none';
}

function domainOf(address: string | undefined): string {
  const a = (address || '').toLowerCase();
  const i = a.lastIndexOf('@');
  return i >= 0 ? a.slice(i + 1).trim() : '';
}

function readAuth(
  message: ForwardableEmailMessage,
  fromAddress: string | undefined
): MailAuth {
  const raw = message.headers.get('authentication-results') || '';
  const dmarc = verdictFor(raw, 'dmarc');
  const spf = verdictFor(raw, 'spf');
  const dkim = verdictFor(raw, 'dkim');

  // Alignment: the envelope sender (SMTP MAIL FROM) must share the From domain.
  // Without it, a DMARC pass earned by some other domain proves nothing about
  // the address the reader actually sees.
  const envelope = domainOf(message.from);
  const header = domainOf(fromAddress);
  const aligned = !!envelope && !!header && (envelope === header || envelope.endsWith('.' + header));

  return {
    dmarc,
    spf,
    dkim,
    aligned,
    verified: dmarc === 'pass' && aligned,
    ...(raw ? { raw: raw.slice(0, 600) } : {}),
  };
}

// Inbound origin: a human counterparty writing in is 'human' by default.
// 'auto' only for messages that self-identify as automated — bounces,
// autoresponders, bulk mail — via standard headers (RFC 3834 / RFC 2919).
function classifyInboundOrigin(message: ForwardableEmailMessage): 'human' | 'auto' {
  const autoSubmitted = (message.headers.get('auto-submitted') || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto';
  const precedence = (message.headers.get('precedence') || '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'auto_reply') return 'auto';
  if (message.headers.get('x-autoreply') || message.headers.get('x-autorespond')) return 'auto';
  return 'human';
}

// Read the raw MIME stream fully into a Uint8Array for the parser.
async function readRaw(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const buf = new Uint8Array(size);
  const reader = stream.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      buf.set(value, offset);
      offset += value.length;
    }
  }
  return offset === size ? buf : buf.subarray(0, offset);
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  // The mailbox this record belongs to = the recipient address Cloudflare
  // routed to us (matches how `sent` records key on the From address).
  const mailbox = (message.to || '').trim().toLowerCase();

  // Owner personal → Gmail only (CF Email Routing forward). If a catch-all
  // or mis-rule still delivers here, drop without R2 archive.
  if (isOwnerGmailOnly(mailbox) || mailbox === OWNER_PERSONAL_ADDRESS) {
    console.log(
      JSON.stringify({
        scope: 'email-inbound',
        success: true,
        skipped: 'owner_gmail_forward',
        mailbox,
        forward_to: OWNER_GMAIL_FORWARD,
        from: message.from,
      }),
    );
    return;
  }

  try {
    const raw = await readRaw(message.raw, message.rawSize);
    const parsed = await PostalMime.parse(raw);

    const toList = (parsed.to || []).map((a) => a.address).filter(Boolean) as string[];
    const ccList = (parsed.cc || []).map((a) => a.address).filter(Boolean) as string[];

    const fromAddress = parsed.from?.address || message.from;
    const auth = readAuth(message, fromAddress);

    await archiveEmail(env, 'received', mailbox || (toList[0] ?? 'unknown'), {
      from: fromAddress,
      auth,
      to: toList.length ? toList : (message.to || undefined),
      cc: ccList.length ? ccList : undefined,
      subject: parsed.subject || '(no subject)',
      text: parsed.text || undefined,
      html: parsed.html || undefined,
      messageId: parsed.messageId || message.headers.get('message-id') || undefined,
      // Thread grouping: In-Reply-To links a reply to its parent; fall back to
      // References head. Lets the UI cluster a conversation later if needed.
      threadId:
        parsed.inReplyTo ||
        headerList(message.headers.get('references') || undefined)?.[0] ||
        undefined,
      origin: classifyInboundOrigin(message),
      // Owner 2026-07-29: the parser produced these all along and we dropped
      // them on the floor, so every cid: logo and attached photo rendered as a
      // broken box in /emailer. archiveEmail stores the bytes separately.
      attachments: parsed.attachments?.length ? parsed.attachments : undefined,
    });
  } catch (err) {
    // Never reject the message on a parse/archive failure — bouncing customer
    // mail is worse than a missing archive row. Log and let it drop silently.
    console.log(
      JSON.stringify({
        scope: 'email-inbound',
        success: false,
        mailbox,
        from: message.from,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
