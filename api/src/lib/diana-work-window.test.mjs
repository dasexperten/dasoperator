import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dianaWorkWindow } from './diana-work-window.mjs';

test('Direct works 06:00–02:00 Yerevan at every minute', () => {
  const midnight = Date.parse('2026-11-10T00:00:00+03:00');
  for (let i = 0; i < 1440; i++) {
    const result = dianaWorkWindow(midnight + i * 60000);
    assert.equal(result.direct, i >= 300 || i < 60); // Owner 2026-11-12: 06:00–02:00 Yerevan
    assert.equal(result.round, i < 30 ? 'night' : i >= 360 && i < 390 ? 'morning' : null);
    assert.equal(result.date, '2026-11-10');
  }
});
