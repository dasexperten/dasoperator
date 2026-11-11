import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findMissingButtons, runButtonWatch } from './diana-button-watch.mjs';
function db() {
  const s = new DatabaseSync(':memory:');
  s.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE ugc_ig_messages(id TEXT PRIMARY KEY, conversation_id TEXT, direction TEXT, from_username TEXT, text TEXT, created_at TEXT);
    CREATE TABLE ugc_payouts(id TEXT, creator_id TEXT, handle TEXT, created_at INTEGER);
    CREATE TABLE ugc_creator_platforms(id TEXT, creator_id TEXT, platform TEXT, normalized_handle TEXT);`);
  return { s, prepare(sql) { let v = []; return { bind(...a) { v = a; return this; },
    async first() { return s.prepare(sql).get(...v) ?? null; }, async all() { return { results: s.prepare(sql).all(...v) }; },
    async run() { return { meta: { changes: Number(s.prepare(sql).run(...v).changes) } }; } }; } };
}
const now = Date.parse('2026-11-11T15:00:00Z');
function seed(d) {
  const ins = d.s.prepare('INSERT INTO ugc_ig_messages VALUES(?,?,?,?,?,?)');
  ins.run('o1', 'c1', 'out', 'dasexperten', 'Пришлите телефон, банк и имя', '2026-11-08T08:11:00Z');
  ins.run('i1', 'c1', 'in', '_bikmatinki', '89123587646 альфа банк', '2026-11-08T09:27:00Z');
  ins.run('i2', 'c1', 'in', '_bikmatinki', 'Оксана Б.', '2026-11-08T09:27:30Z');
  ins.run('i3', 'c2', 'in', 'just_chat', 'Здравствуйте!', '2026-11-10T09:00:00Z');
}
test('details without a payout are listed; a chat without details is not', async () => {
  const d = db(); seed(d);
  const m = await findMissingButtons(d, now);
  assert.equal(m.length, 1); assert.equal(m[0].handle, '_bikmatinki'); assert.equal(m[0].first_name, 'Оксана');
  assert.doesNotMatch(JSON.stringify(m), /9123587646/); // never stores the phone
});
test('a payout from the same cycle clears it; the watch runs once per hour', async () => {
  const d = db(); seed(d);
  assert.equal(await runButtonWatch(d, now), 1);
  assert.equal(await runButtonWatch(d, now + 60_000), null);
  d.s.prepare('INSERT INTO ugc_payouts VALUES(?,?,?,?)').run('p', 'cr', '_bikmatinki', now);
  assert.equal(await runButtonWatch(d, now + 3_600_000), 0);
});
