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
  const { workspaceStatus, syncWorkspacePage, workspaceAccounts, syncWorkspaceAccount } = await import(join(dir, 'workspace.mjs'));
  const env = { GOOGLE_WORKSPACE_CLIENT_ID: 'test-client', GOOGLE_WORKSPACE_CLIENT_SECRET: 'test-secret', GOOGLE_WORKSPACE_ACCOUNTS: JSON.stringify([{ email: 'sales@dasexperten.com', refreshToken: 'test-refresh' }]) };
  assert.throws(() => workspaceAccounts({ GOOGLE_WORKSPACE_ACCOUNTS: JSON.stringify([{ email: 'dasexperten@gmail.com', refreshToken: 'x' }]) }));
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'token' } : String(url).endsWith('/profile') ? { emailAddress: 'wrong@dasexperten.com' } : {}));
  let status = await workspaceStatus(env);
  assert.equal(status.accounts[0].connected, false);
  assert.equal(status.replacementReady, false);
  for (const address of ['eurasia@dasexperten.com', 'emea@dasexperten.com', 'marketing@dasexperten.com', 'hello@dasexperten.com', 'orders@dasexperten.com', 'zakaz@dasexperten.ru', 'oplata@dasexperten.ru', 'dostavka@dasexperten.ru', 'shop@dasexperten.ru', 'geo@dasexperten.com']) assert(status.addresses.some(a => a.address === address));
  assert(!status.addresses.some(a => a.address === 'dr.badalyan@dasexperten.com'));
  await assert.rejects(() => syncWorkspacePage(env, 'sales@dasexperten.com'), /mismatch/);
  globalThis.fetch = async () => new Response('{"access_token":"secret-that-must-not-leak"}', { status: 401 });
  status = await workspaceStatus(env);
  assert(!JSON.stringify(status).includes('secret-that-must-not-leak'));
  assert.equal(status.accounts[0].connected, false);
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'token' } : String(url).endsWith('/profile') ? { emailAddress: 'sales@dasexperten.com', messagesTotal: 2 } : { sendAs: [{ sendAsEmail: 'sales@dasexperten.com', isPrimary: true }, { sendAsEmail: 'legal@dasexperten.com', verificationStatus: 'pending' }] }));
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
  // Exercise the scheduled state machine with conditional storage, multi-page
  // bootstrap, history replay, expiration and a failing durable archive.
  const etags = new Map();
  let sequence = 0;
  const durable = {
    ...archive,
    get: async key => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)), text: async () => objects.get(key), etag: etags.get(key) || 'old' } : null,
    put: async (key, value, options) => {
      const condition = options?.onlyIf;
      if (condition?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      if (condition?.etagMatches && condition.etagMatches !== (etags.get(key) || 'old')) return null;
      const etag = String(++sequence);
      objects.set(key, value); etags.set(key, etag);
      return { etag };
    },
  };
  const scheduledEnv = { ...syncEnv, ARCHIVE: durable };
  const account = workspaceAccounts(env)[0];
  const stateKey = `Workspace/sync/${account.email}.json`;
  const readState = () => JSON.parse(objects.get(stateKey));
  let historyExpired = false;
  let failMessage = false;
  let requestedHistory;
  let historyIds = ['new456'];
  let historyReads = 0;
  globalThis.fetch = async url => {
    const path = new URL(url);
    let data;
    if (path.pathname.endsWith('/token')) data = { access_token: 'token' };
    else if (path.pathname.endsWith('/profile')) data = { emailAddress: account.email, historyId: '100' };
    else if (path.pathname.endsWith('/history')) {
      historyReads++;
      requestedHistory = path.searchParams.get('startHistoryId');
      if (historyExpired) return new Response('{}', { status: 404 });
      data = { historyId: '200', history: [{ messagesAdded: historyIds.map(id => ({ message: { id } })) }] };
    } else if (path.pathname.endsWith('/messages')) {
      data = { messages: [{ id: 'abc123' }], ...(path.searchParams.has('pageToken') ? {} : { nextPageToken: 'page2' }) };
    } else {
      if (failMessage) return new Response('{}', { status: 503 });
      data = { raw: Buffer.from(mime.replace('fixture@example.com', 'new@example.com').replace('customer@example.com', 'shop@dasexperten.ru')).toString('base64url'), threadId: 'thread123', internalDate: '1789257600000', labelIds: ['SENT'] };
    }
    return new Response(JSON.stringify(data));
  };
  await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(readState().mode, 'full');
  assert.equal(readState().historyId, '100');
  assert.equal(readState().pageToken, 'page2');
  await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(readState().mode, 'history');
  failMessage = true;
  assert((await syncWorkspaceAccount(scheduledEnv, account)).error);
  assert.equal(readState().historyId, '100');
  failMessage = false;
  await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(requestedHistory, '100');
  assert.equal(readState().historyId, '200');
  assert.equal(JSON.parse(objects.get(`Workspace/receipts/${account.email}/new456.json`)).direction, 'sent');
  // A single history record can contain more messages than the per-tick limit.
  historyIds = Array.from({ length: 25 }, (_, i) => `bulk${i}`);
  await durable.put(stateKey, JSON.stringify({ mode: 'history', historyId: '150' }));
  const firstBatch = await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(firstBatch.archived, 20);
  assert.equal(readState().historyId, '150');
  assert.equal(readState().pendingIds.length, 5);
  const historyReadsBeforeResume = historyReads;
  const secondBatch = await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(secondBatch.archived, 5);
  assert.equal(historyReads, historyReadsBeforeResume);
  assert.equal(readState().historyId, '200');
  assert(JSON.parse(objects.get(`Workspace/receipts/${account.email}/bulk0.json`)).keys[0].startsWith('Inbox/shop@dasexperten.ru/sent/'));
  historyExpired = true;
  await syncWorkspaceAccount(scheduledEnv, account);
  assert.equal(readState().mode, 'full');
  assert.equal(readState().historyId, '100');
  await durable.put(stateKey, JSON.stringify({ ...readState(), leaseUntil: Date.now() + 60000 }));
  assert.equal((await syncWorkspaceAccount(scheduledEnv, account)).busy, true);
  // Two workers racing for a new state: only one can acquire the lease.
  objects.delete(stateKey); etags.delete(stateKey);
  const races = await Promise.all([syncWorkspaceAccount(scheduledEnv, account), syncWorkspaceAccount(scheduledEnv, account)]);
  assert.equal(races.filter(r => r.busy).length, 1);
  console.log('PASS: scheduled bootstrap, history, failure cursor retention, expiry recovery, concurrent lease');
  console.log('PASS: paginated Gmail MIME import, body and attachment archive, receipt replay without duplicate fetch');
  console.log('PASS: business identity, OAuth/redaction, aliases, strict R2/index/attachment failures, retry deduplication and original date');
} finally { await rm(dir, { recursive: true, force: true }); }
