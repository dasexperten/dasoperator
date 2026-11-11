import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { undeliveredChats, expireUndelivered, WINDOW_MS } from './diana-delivery-expiry.mjs';

function db() {
  const s = new DatabaseSync(':memory:');
  s.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE ugc_ig_messages(id TEXT PRIMARY KEY, conversation_id TEXT, direction TEXT, from_id TEXT, from_username TEXT, text TEXT, attachments_json TEXT, created_at TEXT, seen_at TEXT, handled_at TEXT);`);
  return { s, prepare(sql) { let v = []; return { bind(...a) { v = a; return this; },
    async first() { return s.prepare(sql).get(...v) ?? null; },
    async all() { return { results: s.prepare(sql).all(...v) }; },
    async run() { return { meta: { changes: Number(s.prepare(sql).run(...v).changes) } }; } }; } };
}
const lastIn = Date.parse('2026-11-09T09:06:04Z');
function seed(d, { answered = false } = {}) {
  const ins = d.s.prepare('INSERT INTO ugc_ig_messages(id,conversation_id,direction,from_username,created_at) VALUES(?,?,?,?,?)');
  ins.run('m-out', 'c1', 'out', 'dasexperten', '2026-11-06T12:29:05.000Z');
  ins.run('m-in', 'c1', 'in', 'TA991497', '2026-11-09T09:06:04+0000');
  if (answered) ins.run('m-ans', 'c1', 'out', 'dasexperten', '2026-11-09T09:10:00.000Z');
  d.s.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_direct_delivery:c1:m-in', JSON.stringify({ status: 'unknown', conversation_id: 'c1', incoming_id: 'm-in' }), 0);
  d.s.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_direct_event:message:m-in', JSON.stringify({ status: 'needs_review', reason: 'delivery_unknown', attempt: 1 }), 0);
}
const state = (d, k) => JSON.parse(d.s.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(k).value);

test('an answer that reached the chat leaves no mark', async () => {
  const d = db(); seed(d, { answered: true });
  assert.deepEqual(await undeliveredChats(d, lastIn + 3600_000), []);
});

test('inside the Instagram window the chat shows undelivered with its deadline and nothing closes', async () => {
  const d = db(); seed(d);
  const [chat] = await undeliveredChats(d, lastIn + 2 * 86_400_000);
  assert.equal(chat.status, 'undelivered'); assert.equal(chat.handle, 'ta991497');
  assert.equal(chat.until, new Date(lastIn + WINDOW_MS).toISOString());
  assert.equal(await expireUndelivered(d, lastIn + 2 * 86_400_000), 0);
  assert.equal(state(d, 'diana_direct_event:message:m-in').status, 'needs_review');
});

test('after the window the record closes with its final reason and the mark turns expired', async () => {
  const d = db(); seed(d);
  const after = lastIn + WINDOW_MS + 1;
  assert.equal(await expireUndelivered(d, after), 1);
  assert.equal(state(d, 'diana_direct_event:message:m-in').status, 'closed');
  assert.equal(state(d, 'diana_direct_event:message:m-in').note, 'окно истекло, ответ невозможен');
  assert.equal(state(d, 'diana_direct_delivery:c1:m-in').status, 'expired');
  assert.equal((await undeliveredChats(d, after))[0].status, 'expired');
  assert.equal(await expireUndelivered(d, after + 1), 0); // idempotent: nothing left to close
});
