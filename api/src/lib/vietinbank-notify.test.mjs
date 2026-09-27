import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveNotification, notificationSigningText, MAX_BODY_BYTES } from './vietinbank-notify.mjs';

const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
// Disposable in-memory test keys: never saved, deployed or used as bank credentials.
const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const encode = bytes => Buffer.from(bytes).toString('base64');
const publicPem = `-----BEGIN PUBLIC KEY-----\n${encode(await crypto.subtle.exportKey('spki', pair.publicKey))}\n-----END PUBLIC KEY-----`;
const privatePem = `-----BEGIN PRIVATE KEY-----\n${encode(await crypto.subtle.exportKey('pkcs8', pair.privateKey))}\n-----END PRIVATE KEY-----`;
// OAS NotifyRequest examples; fake signature is replaced with test-only signature.
const example = { msgId: 'MSG550e8400-e29b-41d4-a716', providerId: 'VTB01', transId: 'FT23206000123456', transTime: '20201211155758', transType: 'C', custCode: 'VACVAV123456', amount: '100000', remark: 'THANH TOAN HOA DON 123', currencyCode: 'VND', signature: 'test' };
const utf8 = value => new TextEncoder().encode(value);
async function signed(changes = {}) {
  const payload = { ...example, ...changes };
  payload.signature = encode(await crypto.subtle.sign(algorithm, pair.privateKey, utf8(notificationSigningText(payload))));
  return payload;
}
function database() {
  const rows = new Map();
  return { rows, writes: 0, broken: false, prepare(sql) { return { bind: (...args) => ({
    run: async () => {
      this.writes++;
      if (this.broken) throw new Error('private database detail');
      const id = args.slice(0, 2).join(':'); const exists = rows.has(id);
      if (!exists) rows.set(id, { payload_sha256: args[2], raw_payload: args[3] });
      return { success: true, meta: { changes: exists ? 0 : 1 } };
    },
    first: async () => rows.get(args.join(':')),
  }) }; } };
}
function env(DB = database()) { return { DB, VIETINBANK_NOTIFY_ENABLED: 'true', VIETINBANK_NOTIFY_PROFILE: 'RSA_PKCS1_SHA256_UTF8', VIETINBANK_NOTIFY_FIXTURE_REF: 'test-only', VIETINBANK_PROVIDER_ID: 'VTB01', VIETINBANK_BANK_PUBLIC_KEY_PEM: publicPem, VIETINBANK_PARTNER_PRIVATE_KEY_PEM: privatePem }; }
const request = payload => new Request('https://example.invalid/webhooks/vietinbank/notify-bill', { method: 'POST', body: typeof payload === 'string' ? payload : JSON.stringify(payload) });

test('disabled or unconfirmed configuration neither reads input nor touches storage', async () => {
  const config = env(); delete config.VIETINBANK_NOTIFY_FIXTURE_REF;
  const response = await receiveNotification(request('not JSON'), config);
  assert.equal(response.status, 503); assert.equal(config.DB.writes, 0);
});
test('verified delivery persists original unconverted payload before verifiable ACK; duplicate is signed05', async () => {
  const config = env(), payload = await signed();
  for (const expected of ['00', '05']) {
    const response = await receiveNotification(request(payload), config);
    assert.equal(response.status, 200);
    const reply = await response.json(); assert.equal(reply.errorCode, expected);
    assert.equal(config.DB.rows.size, 1);
    assert.equal(JSON.parse([...config.DB.rows.values()][0].raw_payload).amount, '100000');
    assert.equal(await crypto.subtle.verify(algorithm, pair.publicKey, Buffer.from(reply.signature, 'base64'), utf8(reply.transId + reply.errorCode + reply.errorDesc)), true);
  }
});
test('signed-field tampering, malformed signature and amount coercion cannot persist', async () => {
  for (const change of [{ amount: '100001' }, { signature: '@@@' }, { amount: 100000 }, { custCode: null }]) {
    const config = env(), payload = { ...await signed(), ...change };
    assert.ok([400, 401].includes((await receiveNotification(request(payload), config)).status));
    assert.equal(config.DB.writes, 0);
  }
});
test('unsigned routing-field changes on same transId conflict; first record is never overwritten', async () => {
  const config = env(), payload = await signed();
  assert.equal((await receiveNotification(request(payload), config)).status, 200);
  assert.equal((await receiveNotification(request({ ...payload, currencyCode: 'USD' }), config)).status, 409);
  assert.equal(JSON.parse([...config.DB.rows.values()][0].raw_payload).currencyCode, 'VND');
});
test('failed persistence never returns success or signed bank ACK', async () => {
  const config = env(); config.DB.broken = true;
  const response = await receiveNotification(request(await signed()), config);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, code: 'notification_storage_unavailable' });
});
test('resource limit bounds bodies without Content-Length; optional empty fields preserve exact signing bytes', async () => {
  const config = env();
  assert.equal((await receiveNotification(request('x'.repeat(MAX_BODY_BYTES + 1)), config)).status, 413);
  const payload = { ...example, custCode: '', bankTransId: '', amount: '001.00', remark: ' a ' };
  assert.equal(notificationSigningText(payload), payload.transId + payload.transTime + '001.00 a ');
  assert.equal(config.DB.writes, 0);
});
test('deep unsigned additions fail before storage without uncaught errors', async () => {
  const config = env(), payload = await signed();
  const raw = JSON.stringify(payload).slice(0, -1) + ',"extra":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}';
  assert.equal((await receiveNotification(request(raw), config)).status, 400);
  assert.equal(config.DB.writes, 0);
});
test('unsupported RSA key size is configuration failure before body/storage', async () => {
  const small = await crypto.subtle.generateKey({ ...algorithm, modulusLength: 1024 }, true, ['sign', 'verify']);
  const config = env();
  config.VIETINBANK_BANK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${encode(await crypto.subtle.exportKey('spki', small.publicKey))}\n-----END PUBLIC KEY-----`;
  assert.equal((await receiveNotification(request('invalid'), config)).status, 503);
  assert.equal(config.DB.writes, 0);
});
test('actual SQLite migration and unique constraint survive concurrent retry without duplicate rows', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../db/migrations/0104_vietinbank_notification_inbox.sql', import.meta.url), 'utf8'));
  const DB = { prepare: sql => ({ bind: (...args) => ({
    run: async () => { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    first: async () => sqlite.prepare(sql).get(...args),
  }) }) };
  try {
    const config = env(DB), payload = await signed();
    const replies = await Promise.all([receiveNotification(request(payload), config), receiveNotification(request(payload), config)]);
    assert.deepEqual((await Promise.all(replies.map(r => r.json()))).map(r => r.errorCode).sort(), ['00', '05']);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM vietinbank_notification_inbox').get().n, 1);
    assert.equal(sqlite.prepare('SELECT status FROM vietinbank_notification_inbox').get().status, 'quarantined');
  } finally { sqlite.close(); }
});
