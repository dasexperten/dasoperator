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

test('three refusals by the check for the same reason go to /ugc with the draft (yasmin_i.b, Owner 2026-10-18)', () => {
  const now = Date.parse('2026-10-18T12:00:00Z'); const at = new Date(now - 600_000).toISOString();
  let s = null;
  for (let n = 0; n < 2; n++) s = nextReplyFailure(s, { at, handle: 'h', reason: 'command tone, ask with «пожалуйста»', now, draft: 'Выкладывайте!' });
  assert.equal(s.status, 'retry');
  s = nextReplyFailure(s, { at, handle: 'h', reason: 'command tone, ask with «пожалуйста»', now, draft: 'Выкладывайте!' });
  assert.equal(s.status, 'needs_review'); assert.equal(s.kind, 'stuck'); assert.equal(s.draft, 'Выкладывайте!');
  const other = nextReplyFailure(nextReplyFailure(null, { at, handle: 'h', reason: 'off voice', now }), { at, handle: 'h', reason: 'refusal tone', now });
  assert.equal(other.status, 'retry');
});
