import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dianaWorkWindow, directAnswerHours } from './diana-work-window.mjs';

test('Moscow work windows exclude each other at every minute', () => {
  const midnight = Date.parse('2026-11-10T00:00:00+03:00');
  for (let i = 0; i < 1440; i++) {
    const result = dianaWorkWindow(midnight + i * 60000);
    assert.equal(result.direct, i >= 480 && i < 1410);
    assert.equal(result.round, i < 30 ? 'night' : i >= 360 && i < 390 ? 'morning' : null);
    assert.ok(!(result.direct && result.round));
    assert.equal(result.date, '2026-11-10');
  }
});

test('Owner 2026-11-12: Direct answers 06:00–02:00 Yerevan', () => {
  const at = t => directAnswerHours(Date.parse('2026-11-12T' + t + ':00+04:00'));
  assert.equal(at('05:59'), false); assert.equal(at('06:00'), true); assert.equal(at('14:00'), true);
  assert.equal(at('23:59'), true); assert.equal(at('01:59'), true); assert.equal(at('02:00'), false); assert.equal(at('04:00'), false);
});
