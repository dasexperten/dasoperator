import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'mail-drafts-'));
const sqlite = new DatabaseSync(':memory:');
try {
  await build({ entryPoints: ['api/src/routes/email-state.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs') });
  await build({ entryPoints: ['api/src/lib/mail-draft-files.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'files.mjs') });
  const { default: route } = await import(join(dir, 'route.mjs'));
  sqlite.exec(`CREATE TABLE users (id TEXT, name TEXT, role TEXT, active INTEGER, permissions TEXT);
    CREATE TABLE sessions (token TEXT, user_id TEXT, expires_at INTEGER);
    INSERT INTO users VALUES ('alice','Alice','admin',1,'{}'), ('bob','Bob','admin',1,'{}');`);
  const session = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  session.run('alice-test-session-0001', 'alice', Date.now() + 60000);
  session.run('bob-test-session-000002', 'bob', Date.now() + 60000);
  const blobs = new Map();
  const ARCHIVE = {
    async list({prefix}) { return { objects: [...blobs.keys()].filter(key => key.startsWith(prefix)).map(key => ({key})), truncated: false }; },
    async get(key) {
      if (!blobs.has(key)) return null;
      const bytes = blobs.get(key);
      return { size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)), arrayBuffer: async () => bytes.slice().buffer, body: new Response(bytes).body };
    },
    async put(key, data) { blobs.set(key, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)); return {etag:'test'}; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) blobs.delete(key); },
  };
  const DB = { async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }, prepare(sql) {
    const statement = sqlite.prepare(sql);
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args), success: true }; },
      async run() { const result = statement.run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  } };
  async function request(path, method = 'GET', data, token = 'alice-test-session-0001') {
    return route.request(`http://localhost${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, { DB, ARCHIVE });
  }
  assert.equal((await request('/drafts', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/drafts', 'PUT', {}, '')).status, 401);
  assert.equal((await request('/drafts?offset=-1')).status, 400);
  assert.equal((await request('/drafts?offset=NaN')).status, 400);
  assert.equal((await request('/drafts', 'PUT', null)).status, 400);
  assert.equal((await request('/drafts', 'PUT', { mailbox: 'invalid' })).status, 400);
  const draft = { id: 'owned', mailbox: 'legal@dasexperten.com', to: 'client@example.com', cc: 'colleague@example.com', bcc: 'private@example.com', subject: 'Договор', body: 'Первая строка\nВторая строка', in_reply_to: '<parent@example.com>' };
  assert.equal((await request('/drafts', 'PUT', draft)).status, 200);
  let rows = (await (await request('/drafts')).json()).result.drafts;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, draft.body);
  assert.equal(rows[0].cc_addr, draft.cc);
  assert.equal(rows[0].bcc_addr, draft.bcc);
  assert.equal(rows[0].in_reply_to, draft.in_reply_to);
  assert.equal((await request('/drafts', 'PUT', { ...draft, body: 'Edited' })).status, 200);
  assert.equal((await request('/drafts', 'PUT', { ...draft, body: 'Overwritten by another user' }, 'bob-test-session-000002')).status, 403);
  rows = (await (await request('/drafts')).json()).result.drafts;
  assert.equal(rows[0].body, 'Edited');
  const { bcc: _bcc, ...legacyDraft } = draft;
  await request('/drafts', 'PUT', legacyDraft);
  assert.equal((await (await request('/drafts')).json()).result.drafts[0].bcc_addr, draft.bcc);
  assert.equal((await (await request('/drafts', 'GET', undefined, 'bob-test-session-000002')).json()).result.drafts.length, 0);
  await request('/drafts/owned', 'DELETE', undefined, 'bob-test-session-000002');
  assert.equal((await (await request('/drafts')).json()).result.drafts.length, 1);
  for (let i = 0; i < 55; i++) await request('/drafts', 'PUT', { ...draft, id: `draft-${String(i).padStart(2, '0')}` });
  const first = (await (await request('/drafts')).json()).result;
  const second = (await (await request(`/drafts?offset=${first.nextOffset}`)).json()).result;
  assert.equal(first.drafts.length, 50);
  assert.equal(second.drafts.length, 6);
  assert.equal(new Set([...first.drafts, ...second.drafts].map(row => row.id)).size, 56);
  assert.equal(second.nextOffset, null);
  const bytes = Uint8Array.from([0, 1, 255, 123, 10]);
  async function upload(token = 'alice-test-session-0001') {
    const form = new FormData(); form.append('file', new File([bytes], 'договор.bin', {type:'application/octet-stream'}));
    return route.request('http://localhost/drafts/owned/attachments', {method:'POST', headers:{Authorization:`Bearer ${token}`}, body:form}, {DB, ARCHIVE});
  }
  assert.equal((await upload('bob-test-session-000002')).status, 404);
  const uploaded = await upload();
  assert.equal(uploaded.status, 200);
  const file = (await uploaded.json()).result.file;
  assert.equal(file.size, 5);
  const loaded = (await (await request('/drafts/owned/attachments')).json()).result.files;
  assert.equal(loaded[0].filename, 'договор.bin');
  assert.equal((await request('/drafts/owned/attachments', 'GET', undefined, 'bob-test-session-000002')).status, 404);
  const { loadDraftAttachments } = await import(join(dir, 'files.mjs'));
  assert.deepEqual(new Uint8Array((await loadDraftAttachments({DB, ARCHIVE}, 'alice', 'owned', [file.id]))[0].content), bytes);
  await assert.rejects(() => loadDraftAttachments({DB, ARCHIVE}, 'bob', 'owned', [file.id]), /Draft not found/);
  await assert.rejects(() => loadDraftAttachments({DB, ARCHIVE}, 'alice', 'owned', [file.id, file.id]), /Invalid attachment/);
  assert.equal((await request(`/drafts/owned/attachments/${file.id}`, 'DELETE', undefined, 'bob-test-session-000002')).status, 404);
  await request('/drafts/owned', 'DELETE');
  assert.equal([...blobs.keys()].filter(key => key.includes('/owned/')).length, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM email_drafts WHERE id = ?').get('owned').n, 0);
  console.log('Mail drafts: persistence, editing, CC/BCC/thread metadata, pagination, attachment upload/resume/cleanup, authentication and user isolation passed.');
} finally {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
}
