import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImageChecks } from './diana-image-check.mjs';

test('an Ozon basket without a visible seller passes; a different seller still stops it (Owner 2026-10-18)', () => {
  const basket = { kind: 'basket', product: 'yes', seller: 'unknown', amount: 'yes' };
  assert.equal(summarizeImageChecks([basket]).status, 'yes');
  assert.equal(summarizeImageChecks([{ ...basket, seller: 'no' }]).status, 'no');
  assert.equal(summarizeImageChecks([{ ...basket, product: 'unknown' }]).status, 'unknown');
  // Owner 2026-11-11: any marketplace screen with our product line and price counts.
  assert.equal(summarizeImageChecks([{ ...basket, kind: 'order' }]).status, 'yes');
  assert.equal(summarizeImageChecks([{ ...basket, kind: 'listing' }]).status, 'yes');
  assert.equal(summarizeImageChecks([{ ...basket, kind: 'other' }]).status, 'unknown');
});
