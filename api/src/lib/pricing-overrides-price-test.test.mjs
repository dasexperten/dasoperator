import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./pricing-overrides.ts', import.meta.url), 'utf8');

function closeExpiredApprovedPriceTests(manual, nowMs) {
  const end = Date.parse('2026-09-11T09:46:00Z');
  if (nowMs < end) return { manual, changed: false };
  if (manual.PHP?.DE210 !== 499) return { manual, changed: false };
  return { manual: { ...manual, PHP: { ...manual.PHP, DE210: 1849 } }, changed: true };
}

test('PH INNOWEISS 499 remains live until the exact seven-day seam', () => {
  const manual = { PHP: { DE210: 499, DE209: 1809 }, MYR: { DE210: 29.9 } };
  const result = closeExpiredApprovedPriceTests(manual, Date.parse('2026-09-11T09:45:59.999Z'));
  assert.equal(result.changed, false);
  assert.strictEqual(result.manual, manual);
});

test('the unchanged PH test tuple returns to PHP 1849 at expiry', () => {
  const manual = { PHP: { DE210: 499, DE209: 1809 }, MYR: { DE210: 29.9 } };
  const result = closeExpiredApprovedPriceTests(manual, Date.parse('2026-09-11T09:46:00Z'));
  assert.equal(result.changed, true);
  assert.equal(result.manual.PHP.DE210, 1849);
  assert.equal(result.manual.PHP.DE209, 1809);
  assert.equal(result.manual.MYR.DE210, 29.9);
  assert.equal(manual.PHP.DE210, 499, 'pure helper must not mutate its input');
});

test('a later Owner price is never overwritten by the legacy expiry', () => {
  for (const amount of [498, 500, 1899]) {
    const manual = { PHP: { DE210: amount }, MYR: { DE210: 29.9 } };
    const result = closeExpiredApprovedPriceTests(manual, Date.parse('2026-09-12T00:00:00Z'));
    assert.equal(result.changed, false);
    assert.strictEqual(result.manual, manual);
  }
});

test('production source binds the expiry to the shared effective-price read path', () => {
  assert.match(source, /PH_INNOWEISS_TEST_END_UTC = '2026-09-11T09:46:00Z'/);
  assert.match(source, /manual\.PHP\?\.DE210 !== PH_INNOWEISS_TEST_PRICE/);
  assert.match(source, /DE210: PH_INNOWEISS_RETURN_PRICE/);
  assert.match(source, /const expiry = closeExpiredApprovedPriceTests\(manual\)/);
  assert.match(source, /await env\.FX\.put\(OVERRIDES_KEY, JSON\.stringify\(manual\)\)/);
});
