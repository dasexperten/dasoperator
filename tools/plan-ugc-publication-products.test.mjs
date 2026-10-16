import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPublicationProducts } from './plan-ugc-publication-products.mjs';
const source = { source_document: 'book', sheets: [{ sheet: 'Sheet1', rows: [{ row: 10, product_text: 'BIO, GINGER FORCE', url: 'https://www.instagram.com/p/ABC/?hl=ru' }] }] };
const item = { id: 'post', creator_id: 'creator', creator_platform_id: 'profile', source_workbook: 'Blooger Database.xlsx', source_sheet: 'Sheet1', source_row: 10, content_url: 'https://www.instagram.com/p/ABC/', product_status: 'queued' };
const reference = { creator_id: 'creator', creator_platform_id: 'profile', kind: 'product_reference', source_sheet: 'Sheet1', source_row: 10, product_codes: '["DE123","DE203"]' };
test('classifies the exact row and URL without replacing raw offer ids', () => {
  const plan = planPublicationProducts(source, [{ ...item, product_codes: '["DE123AA"]' }], [reference]);
  assert.equal(plan.summary.newly_identified, 1);
  assert.deepEqual(JSON.parse(plan.updates[0].product_codes), ['DE123AA', 'DE123', 'DE203']);
});
test('does not copy account history to a different post or creator', () => {
  assert.equal(planPublicationProducts(source, [{ ...item, content_url: 'https://www.instagram.com/p/OTHER/' }], [reference]).updates.length, 0);
  assert.equal(planPublicationProducts(source, [{ ...item, creator_id: 'other' }], [reference]).updates.length, 0);
});
test('retains a family without inventing a SKU and protects manual classification', () => {
  const family = structuredClone(source); family.sheets[0].rows[0].product_text = 'InnoWeis';
  const plan = planPublicationProducts(family, [item], []);
  assert.equal(plan.updates[0].product_status, 'unknown');
  assert.deepEqual(JSON.parse(plan.updates[0].product_evidence).labels, [{ name: 'INNOWEISS' }]);
  assert.equal(planPublicationProducts(source, [{ ...item, product_source: 'manual' }], [reference]).updates.length, 0);
});
