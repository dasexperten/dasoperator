import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySourceProductNames, sourceRecordIndex, ORIGINAL_BLOGGER_DATABASE, payoutProductRecords, publicationProductLabels } from './ugc-source-records.mjs';

test('names preserve paste/brush identity, ambiguous SCHWARZ is not guessed', () => {
  assert.deepEqual(identifySourceProductNames('SCHWARZ 2 ШТ'), []);
  assert.deepEqual(identifySourceProductNames('Schwartz Зубная щетка, Schwartz паста'), ['DE105', 'DE201']);
  assert.deepEqual(identifySourceProductNames('InnoWeis,BIO 2 шт,KINDER 3+,KINDER 1+,ZUNGER'), ['DE123', 'DE114', 'DE108', 'DE118', 'DE210']);
  assert.deepEqual(identifySourceProductNames('InnoWeis'), ['DE210']);
});

test('Owner mapping: bare INNOWEISS is 210; explicitly named mouthwash stays 310', () => {
  for (const name of ['INNOWEISS', 'InnoWeis', 'INNOWEISS паста']) {
    assert.deepEqual(identifySourceProductNames(name), ['DE210']);
    const index = sourceRecordIndex(payoutProductRecords([{ id: 'p', creator_id: 'c', creator_platform_id: 'ig', product: name }]));
    assert.deepEqual(index.products.get('ig').map(p => p.sku), ['DE210']);
    assert.deepEqual(index.productLabels.get('ig'), []);
  }
  for (const name of ['INNOWEISS mouthwash', 'Ополаскиватель INNOWEISS', 'INNOWEISS DE310']) {
    assert.deepEqual(identifySourceProductNames(name), ['DE310']);
  }
});

test('original workbook wins over the other register; overlapping books are never summed together', () => {
  const row = { creator_id: 'c', kind: 'payment_register', source_sheet: 'Sheet1', amount_minor: 51000 };
  const index = sourceRecordIndex([
    { ...row, source_document: '17FQ-ZBHVNl_R94tFd27Al_irYCedU78H9GoWbi8uK0c', source_row: 10 },
    { ...row, source_document: ORIGINAL_BLOGGER_DATABASE, source_row: 20 },
    { ...row, source_document: ORIGINAL_BLOGGER_DATABASE, source_row: 21, amount_minor: 20000 },
  ]);
  assert.equal(index.payments.get('c').reduce((sum,r) => sum+r.amount_minor,0), 71000);
  assert.equal(index.paymentSources.get('c').length, 2);
  assert.equal(index.payments.get('c')[0].amount_column, 'E');
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

test('payout product belongs only to its explicit profile, with no invented brush model', () => {
  const records = payoutProductRecords([
    { id: 'p1', creator_id: 'c', creator_platform_id: 'ig', product: 'TERMO + щётка Das Experten' },
    { id: 'p2', creator_id: 'c', creator_platform_id: 'tk', product: 'TERMO + щётка INTENSIV' },
    { id: 'p3', creator_id: 'c', product: 'TERMO' },
  ]);
  assert.equal(records.length, 2);
  const index = sourceRecordIndex(records);
  assert.deepEqual(index.products.get('ig').map((p) => p.sku), ['DE209']);
  assert.deepEqual(index.products.get('tk').map((p) => p.sku), ['DE209', 'DE130']);
  assert.equal(index.products.get('ig')[0].source, 'payout_record');
  assert.equal(index.payments.size, 0);
});

test('publication family labels are structured and never become a guessed subtype', () => {
  assert.deepEqual(publicationProductLabels(JSON.stringify({ labels: [{ name: 'INNOWEISS' }, { name: 'guessed SKU' }] })), [{ name: 'INNOWEISS' }]);
  assert.deepEqual(publicationProductLabels('legacy raw evidence'), []);
});

test('a caption resolves a family only on the same publication and platform', () => {
  const row = { creator_id: 'c', creator_platform_id: 'ig', kind: 'product_reference', source_sheet: 'Sheet1', source_row: 2, source_text: 'InnoWeis', product_codes: '[]' };
  const exact = sourceRecordIndex([
    { ...row, source_document: 'book', content_url: 'https://www.instagram.com/reel/ABC/?hl=ru' },
    { ...row, source_document: 'instagram:ABC', content_url: 'https://www.instagram.com/p/ABC/', source_text: 'Артикул 271980094', product_codes: '["DE210"]' },
  ]);
  assert.deepEqual(exact.productLabels.get('ig'), []);
  const other = sourceRecordIndex([
    { ...row, source_document: 'book', content_url: 'https://www.instagram.com/p/OTHER/' },
    { ...row, source_document: 'instagram:ABC', content_url: 'https://www.instagram.com/p/ABC/', source_text: 'Артикул 271980094', product_codes: '["DE210"]' },
  ]);
  assert.deepEqual(other.productLabels.get('ig').map((p) => p.name), ['INNOWEISS']);
});
