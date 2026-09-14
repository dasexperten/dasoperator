import type { Env } from '../types';
import { findMailbox, isOwnerGmailOnly, OWNER_GMAIL_FORWARD } from './mailbox-registry';

const WORKSPACE_DESTINATION = 'sales@dasexperten.com.test-google-a.com';

/** Transitional inbound delivery. Only explicitly enabled business recipients
 * enter this path. Personal mail and unknown/catch-all addresses stay separate. */
export async function forwardWorkspaceInbound(message: ForwardableEmailMessage, env: Env): Promise<boolean> {
  const recipient = message.to.trim().toLowerCase();
  const canonical = findMailbox(recipient)?.address || recipient;
  const enabled = (env.GOOGLE_WORKSPACE_FORWARD_MAILBOXES || '').split(',').map(a => a.trim().toLowerCase());
  if (!enabled.includes(canonical) || isOwnerGmailOnly(recipient)) return false;
  if (!canonical.endsWith('@dasexperten.com')) throw new Error('Workspace forwarding recipient is not configured');

  // Retain the original MIME and SMTP recipient before handing off delivery.
  // Gmail is the daily inbox; its committed history sync builds the ERP index.
  const raw = await new Response(message.raw).arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `Workspace/ingress/${canonical}/${hash}`;
  await env.ARCHIVE.put(`${key}.eml`, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  await env.ARCHIVE.put(`${key}.json`, JSON.stringify({ recipient, canonical, messageId: message.headers.get('message-id'), receivedAt: new Date().toISOString() }));
  const headers = new Headers({ 'X-Das-ERP-Recipient': recipient });
  // Preserve Owner access while Google takes over. A failure in either delivery
  // stays visible as a handler failure, with the original retained for recovery.
  const outcomes = await Promise.allSettled([
    message.forward(WORKSPACE_DESTINATION, headers),
    message.forward(OWNER_GMAIL_FORWARD),
  ]);
  const delivered = outcomes.map((r, i) => ({ destination: i === 0 ? 'workspace' : 'owner', success: r.status === 'fulfilled' }));
  await env.ARCHIVE.put(`${key}.delivery.json`, JSON.stringify({ delivered, checkedAt: new Date().toISOString() }));
  if (outcomes.some(r => r.status === 'rejected')) throw new Error('Workspace dual delivery incomplete; original MIME retained');
  return true;
}
