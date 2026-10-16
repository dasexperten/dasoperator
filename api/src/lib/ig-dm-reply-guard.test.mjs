import test from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from './ig-dm-reply-guard.mjs';

test('a plain reply passes', () => {
  assert.equal(guardReply('{"reply":"Получила, проверяю!","escalate":false,"reason":"req"}').reply, 'Получила, проверяю!');
});
test('money sent is said only when ERP shows paid', () => {
  assert.equal(guardReply('{"reply":"Перевели 560 ₽ — дошло?","escalate":false}').reply, null);
  assert.equal(guardReply('{"reply":"Перевели 560 ₽ — дошло?","escalate":false}', { paid: true }).reply, 'Перевели 560 ₽ — дошло?');
});
test('a promise of payment never leaves', () => {
  const out = guardReply('{"reply":"Переведу завтра!","escalate":false}');
  assert.equal(out.reply, null);
  assert.equal(out.escalate, true);
});
test('escalation and broken output send nothing', () => {
  assert.equal(guardReply('{"reply":"x","escalate":true}').reply, null);
  assert.equal(guardReply('not json').escalate, true);
});
