import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWbSkuDaily, mskDate } from './wb-sku-daily.mjs';

// Run at 05:00 Yerevan on 10 Oct 2026 = 01:00 UTC = 04:00 Moscow.
const now = Date.parse('2026-10-10T01:00:00Z');
const salesFrom = now - 14 * 86400000;
const catalogIds = new Set(['de209', 'de203aa']);

test('Moscow day: 23:30 UTC is already the next Moscow day', () => {
  assert.equal(mskDate(Date.parse('2026-10-09T21:30:00Z')), '2026-10-10');
  assert.equal(mskDate(Date.parse('2026-10-09T20:59:00Z')), '2026-10-09');
});

test('sales: full days only, zero-filled, unknown products dropped, today excluded', () => {
  const salesRows = [
    { date: '2026-10-09T23:50:00', supplierArticle: 'DE209', priceWithDisc: 700 },
    { date: '2026-10-09T10:00:00', supplierArticle: 'DE209', priceWithDisc: 650.5 },
    { date: '2026-10-10T00:10:00', supplierArticle: 'DE209', priceWithDisc: 700 }, // today, not over
    { date: '2026-09-26T12:00:00', supplierArticle: 'DE209', priceWithDisc: 700 }, // partial first day
    { date: '2026-10-08T12:00:00', supplierArticle: 'NOT-IN-CATALOG', priceWithDisc: 1 },
  ];
  const { yesterday, firstSalesDay, rows } = buildWbSkuDaily({ now, salesFrom, salesRows, catalogIds, adFrom: null, adByDay: null, dayFunnel: null, priceMap: null });
  assert.equal(yesterday, '2026-10-09');
  assert.equal(firstSalesDay, '2026-09-27');
  assert.equal(rows.sales.length, 13); // 27.09..09.10 for de209 only
  assert.deepEqual(rows.sales.find(r => r[0] === '2026-10-09'), ['2026-10-09', 'de209', 2, 135050]);
  assert.deepEqual(rows.sales.find(r => r[0] === '2026-10-08'), ['2026-10-08', 'de209', 0, 0]);
  assert.equal(rows.ad.length, 0);
});

test('ad read failed: no ad rows at all, so earlier days keep their spend', () => {
  const { rows } = buildWbSkuDaily({ now, salesFrom, salesRows: [{ date: '2026-10-09T10:00:00', supplierArticle: 'DE209', priceWithDisc: 1 }],
    catalogIds, adFrom: '2026-10-03', adByDay: null, dayFunnel: null, priceMap: null });
  assert.equal(rows.ad.length, 0);
});

test('ad read succeeded: every window day written, missing SKU-day is a real zero', () => {
  const adByDay = new Map([['2026-10-08', new Map([['de203aa', 800]])]]);
  const { rows } = buildWbSkuDaily({ now, salesFrom, salesRows: [], catalogIds, adFrom: '2026-10-03', adByDay, dayFunnel: null, priceMap: null });
  assert.equal(rows.ad.length, 7); // 03.10..09.10 × de203aa
  assert.deepEqual(rows.ad.find(r => r[0] === '2026-10-08'), ['2026-10-08', 'de203aa', 800]);
  assert.deepEqual(rows.ad.find(r => r[0] === '2026-10-09'), ['2026-10-09', 'de203aa', 0]);
});

test('funnel and price land on yesterday', () => {
  const dayFunnel = new Map([['de209', { views: 120, tocart: 9, orders: 3 }], ['unknown', { views: 1 }]]);
  const priceMap = new Map([['de209', 70000]]);
  const { rows } = buildWbSkuDaily({ now, salesFrom, salesRows: [], catalogIds, adFrom: null, adByDay: null, dayFunnel, priceMap });
  assert.deepEqual(rows.funnel, [['2026-10-09', 'de209', 120, 9, 3]]);
  assert.deepEqual(rows.price, [['2026-10-09', 'de209', 70000]]);
});
