import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dianaWorkWindow } from './diana-work-window.mjs';

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
