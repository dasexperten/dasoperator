import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReplyFailure } from './ig-dm-reply-state.mjs';

test('a technical failure retries hourly for a day, then goes to a person (Owner 2026-10-18)', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  const at = new Date(now - 3 * 3_600_000).toISOString();
  let s = null;
  for (let n = 0; n < 3; n++) s = nextReplyFailure(s, { at, handle: 'h', reason: 'unparsable: x', now });
  assert.equal(s.status, 'retry'); assert.equal(s.next_retry_at, now + 3_600_000);
  const late = nextReplyFailure(s, { at, handle: 'h', reason: 'unparsable: x', now: Date.parse(at) + 25 * 3_600_000 });
  assert.equal(late.status, 'needs_review');
  assert.equal(nextReplyFailure(null, { at, handle: 'h', reason: 'спор о старой оплате', now }).status, 'needs_review');
});
