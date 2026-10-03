import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
const out = join(mkdtempSync(join(tmpdir(), 'erp-policy-')), 'policy.mjs');
buildSync({ entryPoints: [fileURLToPath(new URL('./persistent-erp-alert.ts', import.meta.url))], outfile: out,
  bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { shouldReportEpisode, notifyPersistentErpFailure, recordErpRecovery } = await import(pathToFileURL(out).href);
const DAY = 86400;
test('only repeated day-long problems, with daily deduplication; Modulbank is always silent', () => {
  const e = { count: 2, first: 10, last: DAY + 10, notified: null };
  assert.equal(shouldReportEpisode('erp-ru-track', e, e.last), true);
  assert.equal(shouldReportEpisode('erp-ru-track', { ...e, count: 1 }, e.last), false);
  assert.equal(shouldReportEpisode('erp-ru-track', { ...e, last: DAY + 9 }, e.last), false);
  assert.equal(shouldReportEpisode('erp-ru-track', { ...e, notified: e.last - 1 }, e.last), false);
  assert.equal(shouldReportEpisode('erp-ru-track', { ...e, notified: 10 }, e.last), true);
  assert.equal(shouldReportEpisode('erp-ru-track', e, e.last + DAY + 1), false);
  for (const service of ['watchdog:modulbank', 'modulbank_sync', 'erp-modulbank-sync'])
    assert.equal(shouldReportEpisode(service, { ...e, last: 4 * DAY }, 4 * DAY), false);
});

test('real SQL: recovery resets the episode; only acknowledged delivery marks notified', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sync_failures (id TEXT, service_name TEXT, occurred_at INTEGER, notified INTEGER, created_at INTEGER);
    CREATE TABLE erp_cron_runs (worker TEXT, ok INTEGER, started_at TEXT);
    CREATE TABLE auto_heal_log (id TEXT, recipe_id TEXT, service_name TEXT, triggered_by_error TEXT,
      action_taken TEXT, result TEXT, details TEXT, occurred_at INTEGER, duration_ms INTEGER);`);
  const service = 'erp-ru-track';
  const now = Math.floor(Date.now() / 1000);
  const add = (id, ts) => db.prepare('INSERT INTO sync_failures VALUES (?, ?, ?, 0, ?)').run(id, service, ts, now);
  const env = { DB: { prepare(sql) { const stmt = db.prepare(sql); return {
    bind(...args) { return { first: async () => stmt.get(...args) || null, run: async () => stmt.run(...args) }; }
  }; } }, DASORG_API_KEY: 'synthetic', ORGANIZATION: { fetch: async (_url, init) => {
    sends++; texts.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify(delivery ? { ok: true, message_id: 1 } : { ok: false }));
  } } };
  let sends = 0, delivery = true; const texts = [];
  add('a', now - DAY); add('b', now);
  await notifyPersistentErpFailure(env, service, 'b', 'timeout');
  assert.equal(sends, 1);
  assert.match(texts[0], /статусов доставки.*1 сут.*2 неудачных/);
  assert.match(texts[0], /Предлагаю/);
  await notifyPersistentErpFailure(env, service, 'b', 'timeout');
  assert.equal(sends, 1);
  db.prepare('UPDATE sync_failures SET notified = 0').run();
  delivery = false;
  await notifyPersistentErpFailure(env, service, 'b', 'timeout');
  assert.equal(db.prepare("SELECT notified FROM sync_failures WHERE id='b'").get().notified, 0);
  db.prepare('INSERT INTO erp_cron_runs VALUES (?,1,?)').run(service, new Date((now - 60) * 1000).toISOString());
  await notifyPersistentErpFailure(env, service, 'b', 'timeout');
  assert.equal(sends, 2); // no third send: intervening clean run resets the clock
  await recordErpRecovery(env, service);
  await recordErpRecovery(env, service);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM auto_heal_log').get().c, 1);
  await notifyPersistentErpFailure(env, service, 'b', 'timeout');
  assert.equal(sends, 2);
  db.close();
});
