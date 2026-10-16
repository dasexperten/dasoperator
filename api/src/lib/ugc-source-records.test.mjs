import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySourceProductNames, sourceRecordIndex } from './ugc-source-records.mjs';

test('names preserve paste/brush identity, ambiguous SCHWARZ is not guessed', () => {
  assert.deepEqual(identifySourceProductNames('SCHWARZ 2 ШТ'), []);
  assert.deepEqual(identifySourceProductNames('Schwartz Зубная щетка, Schwartz паста'), ['DE105', 'DE201']);
  assert.deepEqual(identifySourceProductNames('InnoWeis,BIO 2 шт,KINDER 3+,KINDER 1+,ZUNGER'), ['DE123', 'DE114', 'DE108', 'DE118']);
  assert.deepEqual(identifySourceProductNames('InnoWeis'), []);
});

test('source product history stays at profile level; repeated payment rows remain auditable', () => {
  const base = { creator_id: 'c1', source_document: 'doc', source_sheet: 'Sheet1' };
  const index = sourceRecordIndex([
    { ...base, kind: 'payment_register', source_row: 2, amount_minor: 51000, source_flag: 'TRUE' },
    { ...base, kind: 'payment_register', source_row: 3, amount_minor: 51000, source_flag: 'FALSE' },
    { ...base, kind: 'product_reference', creator_platform_id: 'instagram1', source_row: 4, product_codes: '["DE105","DE123"]' },
  ]);
  assert.equal(index.payments.get('c1').length, 2);
  assert.equal(index.payments.get('c1').reduce((sum, row) => sum + row.amount_minor, 0), 102000);
  assert.equal(index.payments.get('c1')[0].status, undefined);
  assert.equal(index.payments.get('c1')[0].konsol_payment_id, undefined);
  assert.equal(index.products.has('tiktok1'), false);
  assert.deepEqual(index.products.get('instagram1').map((row) => row.sku), ['DE105', 'DE123']);
});
