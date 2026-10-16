import test from 'node:test';
import assert from 'node:assert/strict';

// Same formula as ugc-diagnose.ts (kept pure here): last six non-pinned posts.
function engagementLast6(followers, posts) {
  const six = posts.filter((p) => !p.isPinned).slice(0, 6);
  if (!(followers > 0) || !six.length) return null;
  return six.reduce((s, p) => s + Math.max(0, p.likesCount ?? 0) + Math.max(0, p.commentsCount ?? 0), 0) / six.length / followers * 100;
}

test('ER: mean(likes + comments) of the last six non-pinned posts / followers × 100', () => {
  const posts = [{ isPinned: true, likesCount: 9999 }, ...Array.from({ length: 8 }, () => ({ likesCount: 9, commentsCount: 1 }))];
  assert.equal(engagementLast6(1000, posts), 1);
  assert.equal(engagementLast6(0, posts), null);
  assert.equal(engagementLast6(1000, []), null);
});
