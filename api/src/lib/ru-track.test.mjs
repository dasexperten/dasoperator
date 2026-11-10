import test from 'node:test';
import assert from 'node:assert/strict';
import { runRuTrack } from './ru-track.mjs';

function env() {
  const writes = [];
  return { RU_ADMIN_TOKEN: 'fixture', writes, DB: {
    prepare() { return { bind(...args) { return args; } }; },
    async batch(rows) { writes.push(...rows); },
  } };
}
test('successful storefront response records counts and success timestamp', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, checked: 1, retried: 0, results: [{ mail_shipped: true }], retry_results: [] }));
  const e = env(); assert.equal(await runRuTrack(e), 'checked=1 retried=0 mails=1');
  assert.ok(e.writes.some(x => x[0] === 'ru_track:last_ok_at'));
});
test('a failed retry stays red and never advances last success', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, checked: 0, retried: 1, results: [], retry_results: [{ ok: false, reason: 'EMPTY_DELIVERY_METHODS' }] }));
  const e = env(); await assert.rejects(runRuTrack(e), /EMPTY_DELIVERY_METHODS/);
  assert.equal(e.writes.some(x => x[0] === 'ru_track:last_ok_at'), false);
});
test('malformed success or missing credential remains a failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const e = env(); await assert.rejects(runRuTrack(e), /incomplete/);
  delete e.RU_ADMIN_TOKEN; await assert.rejects(runRuTrack(e), /SITE_SYNC_TOKEN/);
});
