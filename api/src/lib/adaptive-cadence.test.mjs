// node --test api/src/lib/adaptive-cadence.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCadence, laneDue, afterCheck } from './adaptive-cadence.mjs';

test('activity → 3 min; first idle → 15; idle again → 30, and stays 30', () => {
  assert.deepEqual(nextCadence(true, 5), { delayMin: 3, idle: 0 });
  assert.deepEqual(nextCadence(false, 0), { delayMin: 15, idle: 1 });
  assert.deepEqual(nextCadence(false, 1), { delayMin: 30, idle: 2 });
  assert.deepEqual(nextCadence(false, 9), { delayMin: 30, idle: 10 });
});

test('the whole loop: 3, 3, 15, 30, 30, then activity restarts at 3', () => {
  let s = null, t = 0;
  const seq = [];
  for (const act of [true, true, false, false, false, true, false]) {
    assert.ok(laneDue(s, t));
    s = afterCheck(s, act, t);
    seq.push(s.delay_min);
    assert.ok(!laneDue(s, t + 60_000 * (s.delay_min - 1)));
    t = s.next_at;
  }
  assert.deepEqual(seq, [3, 3, 15, 30, 30, 3, 15]);
});

test('no state is due', () => {
  assert.equal(laneDue(null, 0), true);
  assert.equal(laneDue({ next_at: NaN }, 0), true);
});
