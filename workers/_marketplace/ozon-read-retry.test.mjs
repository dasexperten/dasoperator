import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackBackoffMilliseconds,
  fetchOzonRead,
  retryAfterMilliseconds,
} from './ozon-read-retry.mjs';

test('Retry-After supports seconds and HTTP dates', () => {
  assert.equal(retryAfterMilliseconds(new Headers({ 'Retry-After': '7' }), 0), 7000);
  assert.equal(retryAfterMilliseconds(new Headers({ 'Retry-After': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 0), 5000);
  assert.equal(retryAfterMilliseconds(new Headers(), 0), null);
});

test('fallback backoff is exponential and capped', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(fallbackBackoffMilliseconds), [2000, 4000, 8000, 16000, 60000]);
});

test('429 is drained, delayed and retried', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1
      ? new Response('limited', { status: 429, headers: { 'Retry-After': '3' } })
      : new Response('{"ok":true}', { status: 200 });
  };
  const { response, attempts } = await fetchOzonRead('https://api-seller.ozon.ru/v1/analytics/stocks', {}, {
    attempts: 3,
    spacingMs: 0,
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl,
    now: () => 0,
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [3000]);
});

test('final 429 is returned after bounded attempts', async () => {
  let calls = 0;
  const { response, attempts } = await fetchOzonRead('https://api-seller.ozon.ru/v1/analytics/stocks', {}, {
    attempts: 3,
    spacingMs: 0,
    sleep: async () => undefined,
    fetchImpl: async () => { calls++; return new Response('limited', { status: 429 }); },
    now: () => 0,
  });
  assert.equal(response.status, 429);
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
});

test('each retry receives a fresh timeout signal', async () => {
  const signals = [];
  let calls = 0;
  await fetchOzonRead('https://api-seller.ozon.ru/v1/analytics/stocks', {}, {
    attempts: 2,
    spacingMs: 0,
    timeoutMs: 1000,
    sleep: async () => undefined,
    fetchImpl: async (_url, init) => {
      calls++;
      signals.push(init.signal);
      return new Response(calls === 1 ? 'limited' : 'ok', { status: calls === 1 ? 429 : 200 });
    },
    now: () => 0,
  });
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});
