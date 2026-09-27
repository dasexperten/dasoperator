import contract from './vietinbank-notify-schema.mjs';

// This receiver quarantines authenticated notifications, never accounting entries.
// Padding/encoding require explicit bank-fixture confirmation before activation.
const PROFILE = 'RSA_PKCS1_SHA256_UTF8';
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const encoder = new TextEncoder();
export const MAX_BODY_BYTES = 32768; // Local resource bound, not a bank contractual limit.
export const SIGNED_FIELDS = ['transId', 'transTime', 'custCode', 'amount', 'bankTransId', 'remark'];
const fail = (status, code) => Response.json({ success: false, code }, { status });

export function validateNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = contract.NotifyRequest;
  for (const key of schema.required) if (!Object.hasOwn(value, key)) return false;
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'string' || [...value[key]].length > rule.maxLength) return false;
    if (rule.enum && !rule.enum.includes(value[key])) return false;
  }
  return ['providerId', 'transId', 'signature'].every(key => value[key].length > 0);
}
export function notificationSigningText(value) {
  // Preserve spelling, whitespace, decimal representation and case. Never coerce.
  if (!validateNotification(value)) throw new Error('invalid_notification');
  return SIGNED_FIELDS.map(key => value[key] ?? '').join('');
}
function decode(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_base64');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function pem(value, kind) {
  const match = value.match(new RegExp(`^\\s*-----BEGIN ${kind}-----([\\s\\S]+)-----END ${kind}-----\\s*$`));
  if (!match) throw new Error('invalid_key');
  return decode(match[1].replace(/\s/g, ''));
}
function stable(value, depth = 0) {
  if (depth > 32) throw new Error('payload_nesting_limit'); // Local resource bound.
  if (Array.isArray(value)) return '[' + value.map(item => stable(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}
async function boundedBody(request) {
  if (!request.body) throw new Error('invalid_body');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function receiveConfiguredNotification(request, env) {
  // No body read, DB access or sensitive logging while configuration is absent.
  if (env.VIETINBANK_NOTIFY_ENABLED !== 'true' ||
      env.VIETINBANK_NOTIFY_PROFILE !== PROFILE ||
      !env.VIETINBANK_NOTIFY_FIXTURE_REF?.trim() ||
      !env.VIETINBANK_PROVIDER_ID?.trim() ||
      !env.VIETINBANK_BANK_PUBLIC_KEY_PEM || !env.VIETINBANK_PARTNER_PRIVATE_KEY_PEM || !env.DB)
    return fail(503, 'vietinbank_not_configured');
  let bankKey, partnerKey;
  try {
    bankKey = await crypto.subtle.importKey('spki', pem(env.VIETINBANK_BANK_PUBLIC_KEY_PEM, 'PUBLIC KEY'), ALGORITHM, false, ['verify']);
    partnerKey = await crypto.subtle.importKey('pkcs8', pem(env.VIETINBANK_PARTNER_PRIVATE_KEY_PEM, 'PRIVATE KEY'), ALGORITHM, false, ['sign']);
    if (bankKey.algorithm.modulusLength !== 2048 || partnerKey.algorithm.modulusLength !== 2048) throw new Error('invalid_key_size');
  } catch { return fail(503, 'vietinbank_invalid_configuration'); }
  let raw, payload;
  try { raw = await boundedBody(request); payload = JSON.parse(raw); }
  catch (error) { return fail(error.message === 'body_too_large' ? 413 : 400, 'invalid_notification'); }
  if (!validateNotification(payload) || payload.providerId !== env.VIETINBANK_PROVIDER_ID) return fail(400, 'invalid_notification');
  try {
    if (!await crypto.subtle.verify(ALGORITHM, bankKey, decode(payload.signature), encoder.encode(notificationSigningText(payload))))
      return fail(401, 'invalid_signature');
  } catch { return fail(401, 'invalid_signature'); }
  // Include unsigned routing fields in identity comparison: they are untrusted
  // even after signature verification. No account/currency/direction is inferred.
  let identity;
  try { identity = stable(payload); } catch { return fail(400, 'invalid_notification'); }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(identity));
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  let duplicate;
  try {
    const insert = await env.DB.prepare(`INSERT INTO vietinbank_notification_inbox
      (provider_id, trans_id, payload_sha256, raw_payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id, trans_id) DO NOTHING`).bind(payload.providerId, payload.transId, hash, raw).run();
    if (!insert.success) throw new Error('storage_failed');
    const stored = await env.DB.prepare(`SELECT payload_sha256 FROM vietinbank_notification_inbox
      WHERE provider_id = ? AND trans_id = ?`).bind(payload.providerId, payload.transId).first();
    if (!stored) throw new Error('storage_failed');
    if (stored.payload_sha256 !== hash) return fail(409, 'notification_conflict');
    duplicate = insert.meta.changes === 0;
  } catch { return fail(503, 'notification_storage_unavailable'); }
  const reply = { transId: payload.transId, providerId: payload.providerId,
    errorCode: duplicate ? '05' : '00', errorDesc: duplicate ? 'Duplicate transaction' : 'Success' };
  try {
    const signature = await crypto.subtle.sign(ALGORITHM, partnerKey, encoder.encode(reply.transId + reply.errorCode + reply.errorDesc));
    return Response.json({ ...reply, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) });
  } catch { return fail(503, 'notification_signing_unavailable'); }
}

export async function receiveNotification(request, env) {
  try { return await receiveConfiguredNotification(request, env); }
  catch { return fail(503, 'notification_processing_unavailable'); }
}
