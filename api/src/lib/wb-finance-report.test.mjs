import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'wb-finance-test-'));
buildSync({ entryPoints: [fileURLToPath(new URL('./marketplace-pull.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'pull.mjs') });
buildSync({ entryPoints: [fileURLToPath(new URL('./wb-finance-report.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'finance.mjs') });
buildSync({ entryPoints: [fileURLToPath(new URL('./wb-gateway.ts', import.meta.url))], bundle: true,
  platform: 'node', format: 'esm', outfile: join(dir, 'gateway.mjs') });
const { wbRealizationRequest, normalizeWbFinanceRow, WB_REALIZATION_URL } = await import(pathToFileURL(join(dir, 'finance.mjs')));
const { wbPolicy } = await import(pathToFileURL(join(dir, 'gateway.mjs')));
const { tickMarketplacePull } = await import(pathToFileURL(join(dir, 'pull.mjs')));

test('Finance endpoint passes the central gateway at the official one-minute limit', () => {
  assert.equal(wbPolicy(new URL(WB_REALIZATION_URL)).interval, 65000);
  assert.throws(() => wbPolicy(new URL('https://finance-api.wildberries.ru.evil.test/api/finance/v1/sales-reports/detailed')));
});
test('POST pagination uses camelCase cursor and explicitly requests weekly reports', () => {
  assert.deepEqual(wbRealizationRequest({ period_from: '2026-09-21', period_to: '2026-09-27', pagination_token: '123456' }), {
    dateFrom: '2026-09-21', dateTo: '2026-09-27', limit: 10000, rrdId: 123456, period: 'weekly',
  });
  assert.throws(() => wbRealizationRequest({ period_from: '', period_to: '', pagination_token: 'bad' }));
});
test('decimal Finance amounts retain RUB precision and map to established staging columns', () => {
  const raw = { rrdId: 123456, vendorCode: ' DE206AA ', sellerOperName: 'Продажа', quantity: 1,
    retailPrice: '1249', retailAmount: '367', vw: '22.25', forPay: '376.99', deliveryService: '12.54',
    penalty: '1.35', rebillLogisticCost: '1.349', paidStorage: '9.12', deduction: '6.54', paidAcceptance: '8.65',
    saleDt: '2026-09-21', reportId: 100, nmId: 255312431 };
  const row = normalizeWbFinanceRow(raw);
  assert.equal(row.sa_name, 'de206aa');
  assert.equal(row.ppvz_for_pay, 376.99);
  assert.equal(row.delivery_rub, 12.54);
  assert.equal(row.ppvz_vw, 22.25);
  assert.equal(row.storage_fee, 9.12);
  assert.equal(row.acceptance, 8.65);
  assert.equal(row.rebill_logistic_cost, 1.349);
  assert.deepEqual(JSON.parse(row.raw_json), raw);
});
test('pool rows remain pool rows and malformed row IDs or amounts cannot become silent zeroes', () => {
  assert.equal(normalizeWbFinanceRow({ rrdId: 10, paidStorage: '2.25' }).sa_name, '');
  assert.throws(() => normalizeWbFinanceRow({ forPay: '12' }));
  assert.throws(() => normalizeWbFinanceRow({ rrdId: 10, forPay: 'invalid' }));
});

test('a short page keeps fetching; HTTP 204 completes without parsing an empty body', async (t) => {
  let task = { id: 'test', marketplace: 'wb', status: 'pending', task_type: 'realization',
    period_from: '2026-09-21', period_to: '2026-09-27', pages_done: 0, rows_collected: 0 };
  const writes = [];
  const env = { WB_API_TOKEN: 'fixture', DB: {
    prepare(sql) { let args = []; return {
      bind(...values) { args = values; return this; },
      async first() { return sql.includes('marketplace_pull_tasks') ? task : { bucket: 'claimed' }; },
      async run() { writes.push({sql, args}); },
    }; },
    async batch(statements) { for (const s of statements) await s.run(); },
  } };
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    requestCount++;
    assert.equal(request.method, 'POST'); assert.equal(request.url, WB_REALIZATION_URL);
    const body = await request.json(); assert.equal(body.period, 'weekly');
    if (requestCount === 1) return Response.json([{ rrdId: 101, vendorCode: 'DE206AA', sellerOperName: 'Продажа', quantity: 1, forPay: '376.99' }]);
    assert.equal(body.rrdId, 101);
    return new Response(null, {status: 204});
  });
  assert.equal((await tickMarketplacePull(env)).action, 'page_fetched');
  assert.ok(writes.some(w => w.sql.includes("status='fetching'") && w.args[0] === '101'));
  const staging = writes.find(w => w.sql.includes('INSERT OR REPLACE INTO wb_realization_staging'));
  assert.equal(staging.args[9], 376.99);
  task = {...task, status: 'fetching', pagination_token: '101', pages_done: 1, rows_collected: 1};
  assert.equal((await tickMarketplacePull(env)).action, 'fetch_complete');
  assert.ok(writes.some(w => w.sql.includes("status='fetched'") && w.args[1] === 1));
});

test('WB builder preserves kopecks and negative lines instead of multiplying whole-ruble unit averages', async () => {
  const task = { id: 'rounding-fixture', marketplace: 'wb', status: 'fetched', task_type: 'realization',
    period_from: '2026-09-21', period_to: '2026-09-27' };
  const rows = [
    {sa:'A',qty:3,payout:100},
    {sa:'B',qty:2000,payout:12501.37},
    {sa:'C',qty:1072,payout:-6787.9645},
  ];
  const writes = [];
  const env = { DB: {
    prepare(sql) { let args = []; return {
      bind(...values) { args = values; return this; },
      async first() {
        if (sql.includes('SELECT * FROM marketplace_pull_tasks')) return task;
        if (sql.includes('SUM(storage)')) return {storage:0,deduction:0,penalty:0};
        return null;
      },
      async all() {
        if (sql.includes('GROUP BY TRIM(sa_name)')) return {results:rows};
        if (sql.includes('SELECT id FROM products')) return {results:rows.map(r=>({id:r.sa}))};
        throw new Error(`Unexpected query: ${sql}`);
      },
      async run() { writes.push({sql,args}); },
    }; },
    async batch(statements) { for (const s of statements) await s.run(); },
  } };
  assert.equal((await tickMarketplacePull(env)).action,'built');
  const lines = writes.filter(w=>w.sql.includes('INSERT INTO line_items'));
  assert.deepEqual(lines.map(w=>w.args[7]),[100,12501.37,-6787.96]);
  assert.equal(lines[0].args[5],100/3);
  assert.equal(lines[1].args[5],12501.37/2000);
  const operation = writes.find(w=>w.sql.includes('INSERT INTO operations'));
  assert.equal(operation.args[2],5813.41);
  const pnl = writes.filter(w=>w.sql.includes('INSERT INTO marketplace_pnl_lines'));
  assert.equal(pnl[2].args[14],-6787.9645);
});
