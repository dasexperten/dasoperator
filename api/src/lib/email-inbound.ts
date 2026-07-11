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
import type { Env } from '../types';

// ForwardableEmailMessage is a global type from @cloudflare/workers-types.

function headerList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

  try {
    const raw = await readRaw(message.raw, message.rawSize);
    const parsed = await PostalMime.parse(raw);

    const toList = (parsed.to || []).map((a) => a.address).filter(Boolean) as string[];
    const ccList = (parsed.cc || []).map((a) => a.address).filter(Boolean) as string[];

    await archiveEmail(env, 'received', mailbox || (toList[0] ?? 'unknown'), {
      from: parsed.from?.address || message.from,
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
