import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryRetryOutcome, syncOzonOrdersOnSite } from './site-order-sync.mjs';

test('green transport cannot hide failed shipping attempts', () => {
  const result = deliveryRetryOutcome({ ok: true, retry_results: [
    { ok: false, reason: 'EMPTY_DELIVERY_METHODS' },
    { ok: false, reason: 'OUT_OF_STOCK' },
    { ok: false, reason: 'api_403' },
  ] });
  assert.equal(result.ok, false);
  assert.match(result.error, /3; EMPTY_DELIVERY_METHODS, OUT_OF_STOCK, api_403/);
});
test('successful retries and idle polling remain successful', () => {
  for (const body of [{ ok: true }, { ok: true, retry_results: [] },
    { ok: true, retry_results: [{ ok: true }] }]) {
    assert.equal(deliveryRetryOutcome(body), body);
  }
});
test('partial success fails and unknown reasons do not print customer content', () => {
  const result = deliveryRetryOutcome({ ok: true, retry_results: [
    { ok: true }, { ok: false, reason: 'customer private details here' },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Delivery retries unresolved: 1; unknown');
});
test('real sync function returns failed business outcome without another request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ ok: true, retry_results: [{ ok: false, reason: 'api_403' }] });
  });
  const result = await syncOzonOrdersOnSite({ SITE_SYNC_TOKEN: 'fixture-only' });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});
