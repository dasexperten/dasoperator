import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { transformSync } = createRequire(import.meta.url)('esbuild');
import { readFileSync } from 'node:fs';
const src = transformSync(readFileSync(new URL('./ozon-shop-days.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' }).code;
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

test('window is the last complete Moscow days, today excluded', () => {
  // 2026-11-24 06:30 UTC = 09:30 MSK
  const w = m.shopDaysWindow(Date.UTC(2026, 10, 24, 6, 30), 5);
  assert.deepEqual(w, { from: '2026-11-19', to: '2026-11-23' });
  // 2026-11-23 22:30 UTC = 01:30 MSK on 24.11 — yesterday is already 23.11
  assert.deepEqual(m.shopDaysWindow(Date.UTC(2026, 10, 23, 22, 30), 1), { from: '2026-11-23', to: '2026-11-23' });
});

test('parses Ozon rows, fills missing days with zeros, computes average price', () => {
  const raw = { result: { data: [
    { dimensions: [{ id: '2026-11-23' }], metrics: [400, 102024.4, 130021, 753] },
    { dimensions: [{ id: '2026-11-21' }], metrics: [357, 95890, 113095, 647] },
  ] } };
  const days = m.parseShopDays(raw, '2026-11-21', '2026-11-23');
  assert.equal(days.length, 3);
  assert.deepEqual(days[0], { date: '2026-11-21', orders: 357, revenue_rub: 95890, avg_price_rub: 269, views: 113095, carts: 647 });
  assert.deepEqual(days[1], { date: '2026-11-22', orders: 0, revenue_rub: 0, avg_price_rub: null, views: 0, carts: 0 });
  assert.equal(days[2].avg_price_rub, 255);
});
