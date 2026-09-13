import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'workspace-test-'));
try {
  await build({ entryPoints: ['api/src/lib/google-workspace.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'workspace.mjs') });
  await build({ entryPoints: ['api/src/routes/email-workspace.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs') });
  const { default: route } = await import(join(dir, 'route.mjs'));
  assert.equal((await route.request('http://localhost/status', {}, {})).status, 403);
  assert.equal((await route.request('http://localhost/sync', { method: 'POST' }, {})).status, 403);
  const { workspaceStatus, syncWorkspacePage, workspaceAccounts } = await import(join(dir, 'workspace.mjs'));
  const env = { GOOGLE_WORKSPACE_CLIENT_ID: 'test-client', GOOGLE_WORKSPACE_CLIENT_SECRET: 'test-secret', GOOGLE_WORKSPACE_ACCOUNTS: JSON.stringify([{ email: 'sales@dasexperten.com', refreshToken: 'test-refresh' }]) };
  assert.throws(() => workspaceAccounts({ GOOGLE_WORKSPACE_ACCOUNTS: JSON.stringify([{ email: 'dasexperten@gmail.com', refreshToken: 'x' }]) }));
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'token' } : String(url).endsWith('/profile') ? { emailAddress: 'wrong@dasexperten.com' } : {}));
  let status = await workspaceStatus(env);
  assert.equal(status.accounts[0].connected, false);
  assert.equal(status.replacementReady, false);
  assert.equal(status.addresses.length, 8);
  await assert.rejects(() => syncWorkspacePage(env, 'sales@dasexperten.com'), /mismatch/);
  globalThis.fetch = async () => new Response('{"access_token":"secret-that-must-not-leak"}', { status: 401 });
  status = await workspaceStatus(env);
  assert(!JSON.stringify(status).includes('secret-that-must-not-leak'));
  assert.equal(status.accounts[0].connected, false);
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'token' } : String(url).endsWith('/profile') ? { emailAddress: 'sales@dasexperten.com', messagesTotal: 2 } : { sendAs: [{ sendAsEmail: 'sales@dasexperten.com', verificationStatus: 'accepted' }, { sendAsEmail: 'legal@dasexperten.com', verificationStatus: 'pending' }] }));
  status = await workspaceStatus(env);
  assert.equal(status.addresses.find(a => a.address.startsWith('sales@')).connectedMailbox, 'sales@dasexperten.com');
  assert.equal(status.addresses.find(a => a.address.startsWith('legal@')).connectedMailbox, null);
  assert.equal(status.replacementReady, false);
  assert.equal((await workspaceStatus({})).accounts.length, 0);
  await build({ entryPoints: ['api/src/lib/inbox-archive.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'archive.mjs') });
  const { archiveEmail } = await import(join(dir, 'archive.mjs'));
  const objects = new Map();
  const archive = {
    get: async key => objects.has(key) ? { text: async () => objects.get(key), json: async () => JSON.parse(objects.get(key)), etag: 'etag' } : null,
    head: async key => objects.has(key) ? { key } : null,
    put: async (key, value) => { objects.set(key, value); return {}; },
  };
  const stmt = { bind() { return this; }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ success: true }) };
  const archiveEnv = { ARCHIVE: archive, DB: { prepare: () => stmt, batch: async () => [] }, MAIL_INDEX_WRITE: 'append' };
  const input = { subject: 'fixture', text: 'body', from: 'customer@example.com', to: 'sales@dasexperten.com' };
  const options = { strict: true, recordId: 'workspace-fixture', timestamp: '2026-09-13T00:00:00.000Z' };
  const key = await archiveEmail(archiveEnv, 'received', 'sales@dasexperten.com', input, options);
  await archiveEmail(archiveEnv, 'received', 'sales@dasexperten.com', input, options);
  assert.equal(JSON.parse(objects.get('Inbox/sales@dasexperten.com.json')).length, 1);
  assert.equal(JSON.parse(objects.get(key)).timestamp, options.timestamp);
  await assert.rejects(() => archiveEmail({ ...archiveEnv, ARCHIVE: { ...archive, put: async () => { throw new Error('storage unavailable'); } } }, 'received', 'sales@dasexperten.com', input, options), /storage unavailable/);
  await assert.rejects(() => archiveEmail({ ...archiveEnv, DB: { ...archiveEnv.DB, batch: async () => { throw new Error('index unavailable'); } } }, 'received', 'sales@dasexperten.com', input, options), /index write failed/);
  await assert.rejects(() => archiveEmail(archiveEnv, 'received', 'sales@dasexperten.com', { ...input, attachments: [{ filename: 'too-big.bin', content: new ArrayBuffer(11 * 1024 * 1024) }] }, options), /Attachment archive incomplete/);
  const mime = ['From: customer@example.com', 'To: sales@dasexperten.com', 'Subject: Workspace fixture', 'Message-ID: <fixture@example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '', '--test', 'Content-Type: text/plain; charset=utf-8', '', 'A message body retained in ERP.', '--test', 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', '', 'Attachment content', '--test--', ''].join('\r\n');
  let rawReads = 0;
  globalThis.fetch = async url => {
    const path = String(url);
    let data;
    if (path.includes('/token')) data = { access_token: 'token' };
    else if (path.endsWith('/profile')) data = { emailAddress: 'sales@dasexperten.com' };
    else if (path.includes('/messages/abc123')) { rawReads++; data = { raw: Buffer.from(mime).toString('base64url'), threadId: 'thread123', internalDate: '1789257600000', labelIds: ['INBOX'] }; }
    else data = { messages: [{ id: 'abc123' }], nextPageToken: 'next-page' };
    return new Response(JSON.stringify(data));
  };
  const syncEnv = { ...env, ...archiveEnv };
  const imported = await syncWorkspacePage(syncEnv, 'sales@dasexperten.com');
  assert.equal(imported.nextPageToken, 'next-page');
  assert.equal(imported.complete, false);
  assert.equal(imported.receipts[0].attachments, 1);
  const record = JSON.parse(objects.get(imported.receipts[0].keys[0]));
  assert(record.text.includes('A message body retained in ERP.'));
  assert(objects.has(record.attachments[0].key));
  await syncWorkspacePage(syncEnv, 'sales@dasexperten.com');
  assert.equal(rawReads, 1);
  console.log('PASS: paginated Gmail MIME import, body and attachment archive, receipt replay without duplicate fetch');
  console.log('PASS: business identity, OAuth/redaction, aliases, strict R2/index/attachment failures, retry deduplication and original date');
} finally { await rm(dir, { recursive: true, force: true }); }
