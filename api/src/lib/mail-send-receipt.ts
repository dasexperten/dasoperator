import type { Env } from '../types';
import type { HumanSendResult } from './resend-human';

interface Receipt {
  fingerprint: string;
  createdAt: number;
  leaseUntil: number;
  status: 'sending' | 'accepted' | 'failed';
  result?: HumanSendResult;
}
export async function mailRequestHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Durable result and short lease. Accepted requests never hit the provider a
 * second time, including after its own 24-hour idempotency window has expired. */
export async function withMailSendReceipt(
  env: Env, requestHash: string, payload: unknown, send: () => Promise<HumanSendResult>,
): Promise<HumanSendResult> {
  const key = `MailSendRequests/${requestHash}.json`;
  const fingerprint = await mailRequestHash(JSON.stringify(payload));
  const now = Date.now();
  const object = await env.ARCHIVE.get(key);
  const previous = object ? await object.json<Receipt>() : null;
  if (previous?.fingerprint !== undefined && previous.fingerprint !== fingerprint) {
    return { success: false, error: 'This draft has an earlier send attempt with different content. Check Sent before creating a new message.' };
  }
  if (previous?.status === 'accepted' && previous.result?.success) return previous.result;
  if (previous?.status === 'sending' && previous.leaseUntil > now) {
    return { success: false, error: 'Sending is already in progress. Please wait before retrying.' };
  }
  // Beyond the provider's deduplication window, an uncertain send requires
  // reconciliation with provider history, never an automatic second email.
  if (previous && now - previous.createdAt > 23 * 60 * 60 * 1000) {
    return { success: false, error: 'The earlier send needs verification in Sent. Automatic retry is paused to prevent a duplicate.' };
  }
  const receipt: Receipt = { fingerprint, createdAt: previous?.createdAt ?? now, leaseUntil: now + 90000, status: 'sending' };
  const claim = await env.ARCHIVE.put(key, JSON.stringify(receipt), { onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' } });
  if (!claim) return { success: false, error: 'Another send is in progress. Please wait.' };
  let result: HumanSendResult;
  try { result = await send(); }
  catch { result = { success: false, error: 'Send status is uncertain. Retry this same draft after checking Sent.' }; }
  await env.ARCHIVE.put(key, JSON.stringify({ ...receipt, leaseUntil: 0, status: result.success ? 'accepted' : 'failed', result }), { onlyIf: { etagMatches: claim.etag } }).catch(() => {});
  return result;
}
