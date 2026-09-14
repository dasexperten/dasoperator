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

  const headers = new Headers({ 'X-Das-ERP-Recipient': recipient });
  // Google is the permanent mail store. Forward the untouched message without
  // reading its MIME or writing copies/receipts to R2. Await both deliveries so
  // a provider failure cannot silently acknowledge successful delivery.
  const outcomes = await Promise.allSettled([
    message.forward(WORKSPACE_DESTINATION, headers),
    message.forward(OWNER_GMAIL_FORWARD),
  ]);
  if (outcomes.some(r => r.status === 'rejected')) throw new Error('Workspace dual delivery incomplete');
  return true;
}
