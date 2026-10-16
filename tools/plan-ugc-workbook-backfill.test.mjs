import test from 'node:test';
import assert from 'node:assert/strict';
import { workbookAmountMinor, planWorkbook } from './plan-ugc-workbook-backfill.mjs';

test('sum column parses US grouping, RUB marks and explicit additions without code evaluation', () => {
  assert.equal(workbookAmountMinor('4,472.00 ₽'), 447200);
  assert.equal(workbookAmountMinor('472+6'), 47800);
  assert.equal(workbookAmountMinor('421,50 ₽'), 42150);
  assert.equal(workbookAmountMinor(''), null);
  assert.equal(workbookAmountMinor('1; process.exit()'), null);
});

test('blank A continues a creator, header handle is preserved, NEW numbers are never money', () => {
  const source = { source_document: 'book', sheets: [
    { sheet: 'Sheet1', rows: [{row:1,handle:'creator'}, {row:2,handle:'',amount:'512.00 ₽',products:['DE105AA'],product_text:'SCHWARZ щетка'}, {row:3,handle:'',amount:'200.00 ₽',products:[]}] },
    { sheet: 'NEW', rows: [{row:1,handle:'header'}, {row:2,handle:'creator',platform:'Instagram',products:['210','203'],url:'https://example.test/video'}] },
  ] };
  const plan = planWorkbook(source, [[], [{ id:'p1',creator_id:'c1',normalized_handle:'creator',platform:'instagram' }]]);
  assert.equal(plan.summary.payment_rows, 2);
  assert.equal(plan.records.filter((r) => r.kind === 'payment_register').reduce((sum,r) => sum+r.amount_minor,0), 71200);
  assert.equal(plan.records.filter((r) => r.kind === 'product_reference').length, 2);
  assert.equal(plan.records.some((r) => r.kind==='payment_register' && r.source_sheet==='NEW'), false);
});
