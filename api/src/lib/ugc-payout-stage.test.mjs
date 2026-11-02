import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { followPayoutStage, stageForPayoutStatus } from './ugc-payout-stage.mjs';

function fakeDb(stage, { fail = false } = {}) {
  const row = { stage, updated_at: 1 };
  return { row, prepare: () => ({ bind: (id, next, now, ...from) => ({ run: async () => {
    if (fail) throw new Error('D1 down');
    const moved = from.includes(row.stage ?? '');
    if (moved) { row.stage = next; row.updated_at = now; }
    return { meta: { changes: moved ? 1 : 0 } };
  } }) }) };
}

test('an open payout is cart, money out is paid, a bank refusal is failed', () => {
  for (const status of ['awaiting_approval', 'approved', 'sent']) assert.equal(stageForPayoutStatus(status), 'cart');
  assert.equal(stageForPayoutStatus('paid'), 'paid');
  assert.equal(stageForPayoutStatus('failed'), 'failed');
  assert.equal(stageForPayoutStatus('cancelled'), null);
});

test('the status moves forward from every earlier step and from silent', async () => {
  for (const stage of ['', null, 'replied', 'agreed', 'silent']) {
    const db = fakeDb(stage);
    assert.equal(await followPayoutStage(db, 'c1', 'approved', 5), true);
    assert.equal(db.row.stage, 'cart');
  }
  for (const stage of ['cart', 'failed', 'silent']) {
    const db = fakeDb(stage);
    await followPayoutStage(db, 'c1', 'paid', 5);
    assert.equal(db.row.stage, 'paid');
  }
});

test('it never moves back and never overrides a side decision', async () => {
  for (const [stage, payout] of [['paid', 'approved'], ['ordered', 'paid'], ['creation', 'failed'], ['posted', 'paid'], ['gold', 'sent'],
    ['refused', 'paid'], ['fee', 'approved'], ['unfit', 'paid'], ['rival', 'paid'], ['owner', 'failed'], ['failed', 'approved']]) {
    const db = fakeDb(stage);
    assert.equal(await followPayoutStage(db, 'c1', payout, 5), false, `${stage} + ${payout}`);
    assert.equal(db.row.stage, stage);
    assert.equal(db.row.updated_at, 1);
  }
});

test('a database failure does not break the payout write', async () => {
  const log = console.error; console.error = () => {};
  try { assert.equal(await followPayoutStage(fakeDb('cart', { fail: true }), 'c1', 'paid'), false); } finally { console.error = log; }
});

test('every path that writes a payout status follows it', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const count = (text) => (text.match(/followPayoutStage\(/g) ?? []).length;
  assert.equal(count(read('../routes/ugc.ts')), 2, 'create payout and manual status');
  assert.equal(count(read('./ugc-payout-store.ts')), 3, 'markPaid, markFailed, registry link');
  assert.equal(count(read('./ig-dm-reply.ts')), 1, 'payout registered from Direct');
});
