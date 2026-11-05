import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualStage, markReviewed, manualStageKey, parseManualStage } from './ugc-manual-stage.mjs';

test('a changed status is recorded as a manual change awaiting review', () => {
  const record = buildManualStage({ from: 'paid', to: 'ordered', by: 'Aram', at: 1000 });
  assert.deepEqual(record, { from: 'paid', to: 'ordered', by: 'Aram', at: 1000, reviewed_at: null });
});

test('an unchanged status records nothing', () => {
  assert.equal(buildManualStage({ from: 'paid', to: 'paid', by: 'Aram', at: 1 }), null);
});

test('an empty status counts as a change from a real one', () => {
  assert.equal(buildManualStage({ from: 'paid', to: '', by: null, at: 5 })?.to, '');
});

test('parse survives broken input', () => {
  assert.equal(parseManualStage('not json'), null);
  assert.equal(parseManualStage('{"to":1}'), null);
  assert.equal(parseManualStage(null), null);
});

test('review keeps the change and stamps the time', () => {
  const record = buildManualStage({ from: 'creation', to: 'posted', by: 'Aram', at: 10 });
  const reviewed = markReviewed(record, 99);
  assert.equal(reviewed.reviewed_at, 99);
  assert.equal(reviewed.to, 'posted');
  assert.equal(markReviewed(null, 1), null);
});

test('key is per creator', () => {
  assert.equal(manualStageKey('abc'), 'manual_stage:abc');
});
