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
  const { default: route } = await import(join(dir, 'route.mjs'));
  sqlite.exec(`CREATE TABLE users (id TEXT, name TEXT, role TEXT, active INTEGER, permissions TEXT);
    CREATE TABLE sessions (token TEXT, user_id TEXT, expires_at INTEGER);
    INSERT INTO users VALUES ('alice','Alice','admin',1,'{}'), ('bob','Bob','admin',1,'{}');`);
  const session = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  session.run('alice-test-session-0001', 'alice', Date.now() + 60000);
  session.run('bob-test-session-000002', 'bob', Date.now() + 60000);
  const DB = { prepare(sql) {
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
    }, { DB });
  }
  assert.equal((await request('/drafts', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/drafts', 'PUT', {}, '')).status, 401);
  assert.equal((await request('/drafts?offset=-1')).status, 400);
  assert.equal((await request('/drafts?offset=NaN')).status, 400);
  assert.equal((await request('/drafts', 'PUT', null)).status, 400);
  assert.equal((await request('/drafts', 'PUT', { mailbox: 'invalid' })).status, 400);
  const draft = { id: 'owned', mailbox: 'legal@dasexperten.com', to: 'client@example.com', cc: 'colleague@example.com', subject: 'Договор', body: 'Первая строка\nВторая строка', in_reply_to: '<parent@example.com>' };
  assert.equal((await request('/drafts', 'PUT', draft)).status, 200);
  let rows = (await (await request('/drafts')).json()).result.drafts;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, draft.body);
  assert.equal(rows[0].cc_addr, draft.cc);
  assert.equal(rows[0].in_reply_to, draft.in_reply_to);
  assert.equal((await request('/drafts', 'PUT', { ...draft, body: 'Edited' })).status, 200);
  assert.equal((await request('/drafts', 'PUT', { ...draft, body: 'Overwritten by another user' }, 'bob-test-session-000002')).status, 403);
  rows = (await (await request('/drafts')).json()).result.drafts;
  assert.equal(rows[0].body, 'Edited');
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
  await request('/drafts/owned', 'DELETE');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM email_drafts WHERE id = ?').get('owned').n, 0);
  console.log('Mail drafts: persistence, editing, CC/thread metadata, pagination, authentication and user isolation passed.');
} finally {
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
}
