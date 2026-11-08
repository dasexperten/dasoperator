import test from 'node:test';
import assert from 'node:assert/strict';
import {dayKey,signal,validEvidence} from './alarm.mjs';
test('Yerevan date crosses at 20 UTC and stays stable across daily replay',()=>{
  assert.equal(dayKey(new Date('2026-11-08T19:59:59Z')),'erp-order-vn:2026-11-08');
  assert.equal(dayKey(new Date('2026-11-08T20:00:00Z')),'erp-order-vn:2026-11-09');
  assert.equal(dayKey(new Date('2026-11-09T02:00:00Z')),dayKey(new Date('2026-11-09T02:01:00Z')));
});
test('alarm wakes Tet with finance seam and never claims fiscal completion',()=>{
  const row=signal(new Date('2026-11-09T02:00:00Z'));
  assert.equal(row.state,'pending'); assert.equal(row.target,'tet'); assert.equal(row.finance,'justina-timber');
});
test('exit code or bare prose cannot complete a job',()=>{
  assert.ok(!validEvidence({exit_code:0})); assert.ok(!validEvidence({note:'done',evidence:[]}));
  assert.ok(validEvidence({note:'source reconciled',evidence:['operation:real-source-id']}));
});
