import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), { build } = require(require.resolve('esbuild', { paths: [process.cwd() + '/api'] }));
const dir = mkdtempSync(join(tmpdir(), 'ozon-monitor-'));
await build({ entryPoints: [fileURLToPath(new URL('./monitor.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'monitor.mjs') });
const { officialBoost, summarizeBoost, actionStatus, readSameCutoffSales, runPromotionMonitor } = await import(pathToFileURL(join(dir, 'monitor.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
test('official percentage ignores unrelated bonus points and ambiguous descriptions', () => {
  assert.equal(officialBoost('Дополнительно 3%. Дадим акционный бустинг в поиске и категории — <b>65%</b>'), 65);
  assert.equal(officialBoost('Скидка 55%, баллы 3%'), null);
  assert.equal(officialBoost('акционный бустинг в поиске и категории — 55%; акционный бустинг в поиске и категории — 65%'), null);
});
test('actual elastic zero stays zero; nonelastic API zero can use official terms; future support never counts', () => {
  const m = { status: 'active', is_boost: true, is_quarantined: false };
  assert.equal(summarizeBoost([{ ...m, action_type: 'ELASTIC_BOOSTING', current_boost: 0, official_boost: 55 }]).value, 0);
  assert.equal(summarizeBoost([{ ...m, action_type: 'STOCK_DISCOUNT', current_boost: 0, official_boost: 65 }, { ...m, current_boost: 15 }]).value, 65);
  assert.equal(summarizeBoost([{ ...m, status: 'future', official_boost: 65 }]).value, null);
  assert.equal(summarizeBoost([{ ...m, is_quarantined: true, official_boost: 65 }]).status, 'unknown');
  assert.equal(summarizeBoost([{ ...m, alert_max_action_price_failed: true, official_boost: 65 }]).value, null);
  assert.equal(summarizeBoost([{ ...m, is_quarantined: null, official_boost: 65 }]).value, null);
  assert.equal(actionStatus({ date_start: '2026-11-09', date_end: '2026-11-12' }, Date.parse('2026-11-08')), 'future');
});
const at = Date.parse('2026-11-08T10:00:00Z');
const posting = (id, created_at, quantity, extra = {}) => ({ posting_number: id, created_at, status: 'delivered', products: [{ offer_id: 'DE202AA', quantity }], ...extra });
test('same cutoff joins FBO/FBS, respects Yerevan midnight, separates cancellations/buyouts and excludes yesterday afternoon', async () => {
  const request = async path => ({ postings: path.includes('/fbo/') ? [posting('a', '2026-11-07T20:00:00Z', 2), posting('b', '2026-11-07T09:59:00Z', 3), posting('c', '2026-11-07T10:00:00Z', 99), posting('d', '2026-11-08T09:00:00Z', 4, { status: 'cancelled' }), posting('e', '2026-11-08T09:10:00Z', 5, { is_marketplace_buyout: true })] : [posting('f', '2026-11-08T09:00:00Z', 1)], has_next: false });
  const r = await readSameCutoffSales(request, at);
  assert.deepEqual(r.totals.get('de202aa'), { today: 3, yesterday: 3, cancelled_today: 4, cancelled_yesterday: 0, buyout_today: 5, buyout_yesterday: 0 });
  assert.equal(r.coverage.today_start, '2026-11-07T20:00:00.000Z');
});
test('short pages with has_next are read fully, duplicate posting cannot become inflated sales', async () => {
  let calls = 0;
  const request = async path => path.includes('/fbs/') ? { postings: [], has_next: false } : ++calls === 1 ? { postings: [posting('a', '2026-11-08T09:00:00Z', 1)], has_next: true, cursor: 'next' } : { postings: [posting('a', '2026-11-08T09:00:00Z', 1)], has_next: false };
  await assert.rejects(readSameCutoffSales(request, at), /duplicated/);
  assert.equal(calls, 2);
});
test('full catalog includes products without promotions; sales failure is unknown, not zero; no write path requested', async t => {
  t.mock.method(Date, 'now', () => at);
  let saved;
  const env = { DB: { prepare() { return { bind(...args) { this.args = args; return this; }, async first() { return null; }, async run() { saved = JSON.parse(this.args[1]); } }; } } };
  const report = await runPromotionMonitor(env, async path => {
    if (path === '/v5/product/info/prices') return { items: [{ product_id: 1, offer_id: 'DE202AA', price: { marketing_seller_price: '740', min_price: '740' } }], total: 1 };
    if (path === '/v1/actions') return { result: [] };
    if (path === '/v3/product/info/list') return { items: [{ id: 1, name: 'DETOX' }] };
    if (path === '/v3/posting/fbo/list') throw Error('orders unavailable');
    throw Error('unexpected endpoint ' + path);
  });
  assert.equal(report.rows.length, 1); assert.equal(report.rows[0].boost.status, 'none');
  assert.equal(report.sales_available, false); assert.equal(report.rows[0].today_units, null);
  assert.equal(saved.coverage.actions_taken, 0);
});
