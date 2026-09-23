import assert from 'node:assert/strict';
import test from 'node:test';
import { identifyExplicitProducts, initialProductClassification } from './ugc-products.mjs';

test('rolls explicit bundle offers up to canonical DETOX and NANO MASSAGE', () => {
  const result = identifyExplicitProducts(['DE202AA', 'DE120AAAA']);
  assert.deepEqual(result.matches.map((item) => [item.sku, item.name, item.pack_factor]), [
    ['DE202', 'DETOX', 2], ['DE120', 'NANO MASSAGE', 4],
  ]);
  assert.deepEqual(result.unknown_codes, []);
});

test('never guesses an unrecognized explicit code', () => {
  const result = identifyExplicitProducts(['DE3', 'DE123AAAA']);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.unknown_codes, ['DE3', 'DE123AAAA']);
  assert.deepEqual(initialProductClassification(['DE3'], true), { status: 'unknown', source: 'explicit_import', confidence: null, evidence: 'DE3' });
});

test('queues linked publications with no explicit product and leaves no-link rows unknown', () => {
  assert.equal(initialProductClassification([], true).status, 'queued');
  assert.equal(initialProductClassification([], false).status, 'unknown');
});
