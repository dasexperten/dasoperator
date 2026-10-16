import test from 'node:test';
import assert from 'node:assert/strict';
import { engagementLast6, parseCount, parsePostMeta } from './ugc-diagnose-parse.mjs';

test('counts from Instagram meta lines', () => {
  assert.equal(parseCount('3,492'), 3492);
  assert.equal(parseCount('24K'), 24000);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount(''), null);
});

test('post meta: likes, comments, date', () => {
  const p = parsePostMeta('14 likes, 0 comments - krainova_nadya on October 16, 2026: "Свидетели тут не нужны"');
  assert.deepEqual(p, { likes: 14, comments: 0, at: Date.UTC(2026, 9, 16) });
  assert.equal(parsePostMeta('Instagram photos and videos'), null);
});

test('ER: six newest by date, an old pinned post drops out', () => {
  const pinned = { likes: 24000, comments: 108, at: Date.UTC(2026, 2, 9) };
  const fresh = Array.from({ length: 6 }, (_, i) => ({ likes: 9, comments: 1, at: Date.UTC(2026, 9, 10 + i) }));
  assert.equal(engagementLast6(1000, [pinned, ...fresh]), 1);
  assert.equal(engagementLast6(0, fresh), null);
});
