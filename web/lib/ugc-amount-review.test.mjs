import assert from 'node:assert/strict';
import test from 'node:test';
import { createAmountReviewSession, matchesReviewReceipt, parseReviewAmount, reviewAmountInput } from './ugc-amount-review.mjs';

const SNAPSHOT = 'a'.repeat(64);
const UUID = '12345678-1234-4123-8123-123456789abc';
const ROW = { id: 'payout-synthetic', creator_id: 'creator-synthetic', amount_minor: 1, status: 'awaiting_approval', payout_hold: false, review_snapshot: SNAPSHOT, can_edit: true, saved_request: null };
const ok = (result) => ({ success: true, result });
const receipt = (request, patch = {}) => ({ ...ROW, amount_minor: request.amount_minor, payout_hold: true, can_edit: false, review_snapshot: 'b'.repeat(64), saved_request: { ...request }, ...patch });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const setup = (options = {}) => createAmountReviewSession({ id: ROW.id, creatorId: ROW.creator_id, read: async () => ok(ROW), save: async (_, request) => ok(receipt(request)), requestId: () => UUID, ...options });

test('exact integer kopecks for 453, 394 and fractional values; inclusive limits', () => {
  for (const [input, expected] of [['453', 45300], ['453,00', 45300], ['394', 39400], ['453.27', 45327], ['50', 5000], ['999.00', 99900], ['2999.00', 299900], ['1037', 103700], ['050,10', 5010], [' 394,5 ', 39450]]) {
    assert.deepEqual(parseReviewAmount(input), { amount_minor: expected });
  }
  assert.equal(reviewAmountInput(45327), '453.27');
  assert.equal(reviewAmountInput(39400), '394.00');
});

test('malformed and out-of-range amounts never round, strip, or coerce', () => {
  for (const input of ['', '49.99', '2999.01', '3000', '453.001', '453,001', '4e2', '+453', '-453', '4 53', '453 ₽', 'NaN', 'Infinity', '453.', '.50', '453,2.0', 453, null]) {
    assert.equal(typeof parseReviewAmount(input).error, 'string', String(input));
  }
});

test('open performs GET only and submit saves exact amount on the existing row', async () => {
  const calls = []; const saved = [];
  const session = setup({ read: async (...args) => { calls.push(['read', ...args]); return ok(ROW); }, save: async (...args) => { calls.push(['save', ...args]); return ok(receipt(args[1])); }, onSaved: (row) => saved.push(row) });
  await session.open();
  assert.equal(session.getState().phase, 'ready');
  assert.deepEqual(calls, [['read', ROW.id, undefined]]);
  await session.submit('453,27');
  assert.equal(session.getState().phase, 'saved');
  assert.deepEqual(calls[1], ['save', ROW.id, { creator_id: ROW.creator_id, expected_snapshot: SNAPSHOT, amount_minor: 45327, request_id: UUID }]);
  assert.equal(saved[0].payout_hold, true);
  assert.equal(calls.length, 2);
});

test('one synchronous lock prevents double submits and ignores reopening while saving', async () => {
  const pending = deferred(); let count = 0;
  const session = setup({ save: async (_, request) => { count++; await pending.promise; return ok(receipt(request)); } });
  await session.open(); const first = session.submit('394');
  await session.submit('453'); await session.open();
  assert.equal(count, 1); assert.equal(session.getState().phase, 'saving');
  pending.resolve(); await first;
  assert.equal(session.getState().review.amount_minor, 39400);
});

test('invalid input never creates an idempotency request or calls save', async () => {
  let count = 0;
  const session = setup({ requestId: () => { count++; return UUID; }, save: () => { throw new Error('not expected'); } });
  await session.open(); await session.submit('453.001');
  assert.equal(session.getState().phase, 'ready'); assert.equal(session.getState().request, null); assert.equal(count, 0);
});

test('a failed request ID generator fails safely without mutation', async () => {
  for (const requestId of [() => 'bad', () => { throw new Error('missing crypto'); }]) {
    const session = setup({ requestId, save: () => { throw new Error('not expected'); } });
    await session.open(); await session.submit('453');
    assert.equal(session.getState().phase, 'ready'); assert.equal(session.getState().request, null); assert.match(session.getState().error, /запрос/);
  }
});

test('lost response reconciles using the exact same row and UUID receipt', async () => {
  let request; const reads = []; const saved = [];
  const session = setup({ read: async (...args) => { reads.push(args); return ok(request ? receipt(request) : ROW); }, save: async (_, body) => { request = body; throw new Error('lost response'); }, onSaved: (row) => saved.push(row) });
  await session.open(); await session.submit('453');
  assert.deepEqual(reads[1], [ROW.id, UUID]); assert.equal(session.getState().phase, 'saved'); assert.equal(saved.length, 1);
});

test('matching amount alone or a different receipt is never success', async () => {
  for (const change of [{ saved_request: null }, { saved_request: { request_id: 'other', expected_snapshot: SNAPSHOT, amount_minor: 45300 } }, { saved_request: { request_id: UUID, expected_snapshot: 'c'.repeat(64), amount_minor: 45300 } }, { saved_request: { request_id: UUID, expected_snapshot: SNAPSHOT, amount_minor: 39400 } }]) {
    let request; let succeeded = 0;
    const session = setup({ read: async () => ok(request ? receipt(request, change) : ROW), save: async (_, body) => { request = body; throw new Error('lost'); }, onSaved: () => succeeded++ });
    await session.open(); await session.submit('453');
    assert.equal(session.getState().phase, 'blocked'); assert.equal(succeeded, 0);
  }
});

test('success requires same payout, creator, pending status and explicit hold', () => {
  const request = { creator_id: ROW.creator_id, expected_snapshot: SNAPSHOT, amount_minor: 45300, request_id: UUID };
  assert.equal(matchesReviewReceipt(receipt(request), request, ROW.id), true);
  for (const patch of [{ id: 'other' }, { creator_id: 'other' }, { payout_hold: false }, { status: 'paid' }, { status: 'sent' }, { amount_minor: 39400 }]) {
    assert.equal(matchesReviewReceipt(receipt(request, patch), request, ROW.id), false);
  }
});

test('retry preserves the UUID, original snapshot and exact original amount', async () => {
  const saves = []; let uuids = 0;
  const session = setup({ requestId: () => { uuids++; return UUID; }, save: async (_, request) => { saves.push(request); return saves.length === 1 ? { success: false } : ok(receipt(request)); } });
  await session.open(); await session.submit('394.55');
  assert.equal(session.getState().phase, 'retry');
  await session.submit('453');
  assert.deepEqual(saves[0], saves[1]); assert.equal(saves[1].amount_minor, 39455); assert.equal(uuids, 1); assert.equal(session.getState().phase, 'saved');
});

test('close/unsubscribe then reopen retains the in-flight request and reconciles; no replay', async () => {
  let request; let saveCount = 0; let updates = 0;
  const pending = deferred();
  const session = setup({ read: async () => ok(request ? receipt(request) : ROW), save: async (_, body) => { request = body; saveCount++; await pending.promise; throw new Error('lost'); } });
  const unsubscribe = session.subscribe(() => updates++);
  await session.open(); const saving = session.submit('453'); unsubscribe();
  const before = updates; pending.resolve(); await saving;
  assert.equal(updates, before);
  await session.open(); assert.equal(session.getState().phase, 'saved'); assert.equal(saveCount, 1); assert.equal(session.getState().request.request_id, UUID);
});

test('stale snapshot, claimed row, or non-placeholder cannot be retried', async () => {
  for (const patch of [{ review_snapshot: 'c'.repeat(64) }, { can_edit: false }, { amount_minor: 39400 }, { status: 'sent' }]) {
    let attempted = false; let calls = 0;
    const session = setup({ read: async () => ok(attempted ? { ...ROW, ...patch } : ROW), save: async () => { attempted = true; calls++; throw new Error('stale'); } });
    await session.open(); await session.submit('453');
    assert.equal(session.getState().phase, 'blocked'); await session.submit('453'); assert.equal(calls, 1);
  }
});

test('failed reconciliation blocks save until a successful read, then retries same request', async () => {
  let broken = false; let calls = 0; let request;
  const session = setup({ read: async () => { if (broken) throw new Error('offline'); return ok(ROW); }, save: async (_, body) => { request = body; calls++; broken = true; throw new Error('lost'); } });
  await session.open(); await session.submit('394'); assert.equal(session.getState().phase, 'error');
  await session.submit('394'); assert.equal(calls, 1);
  broken = false; await session.open(); assert.equal(session.getState().phase, 'retry'); assert.equal(session.getState().request, request);
});

test('wrong row or invalid snapshot returned on open is fail-closed', async () => {
  for (const patch of [{ id: 'other' }, { creator_id: 'other' }, { review_snapshot: 'guess' }, { payout_hold: undefined }]) {
    const session = setup({ read: async () => ok({ ...ROW, ...patch }) });
    await session.open(); assert.equal(session.getState().phase, 'error');
  }
});

test('non-editable, non-placeholder or paid initial row never offers save', async () => {
  for (const patch of [{ can_edit: false }, { amount_minor: 45300 }, { status: 'paid' }]) {
    const session = setup({ read: async () => ok({ ...ROW, ...patch }) });
    await session.open(); assert.equal(session.getState().phase, 'blocked');
  }
});
