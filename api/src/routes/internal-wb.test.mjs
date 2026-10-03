import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'wb-returns-test-'));
require('esbuild').buildSync({ entryPoints: [fileURLToPath(new URL('./internal-wb.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'route.mjs') });
const { default: route } = await import(pathToFileURL(join(dir, 'route.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fixture() {
  const writes = [];
  return { writes, env: { ERP_RUN_SECRET: 'operator-fixture', WB_API_TOKEN: 'wb-fixture', DB: {
    prepare(sql) { let args; return {
      bind(...v) { args = v; return this; },
      async first() { writes.push({sql,args}); return {bucket: 'claimed'}; },
      async run() { writes.push({sql,args}); },
    }; },
  } } };
}
const path = '/goods-returns?dateFrom=2026-09-03&dateTo=2026-10-03';
const request = (env, p = path, token = 'operator-fixture') => route.request(p, {headers: {Authorization: `Bearer ${token}`}}, env);

test('missing/wrong operator credentials cannot query or reveal return records', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const {env,writes} = fixture();
  assert.equal((await request(env,path,'wrong')).status,401);
  assert.equal((await route.request('/settlements/op_wb_260927_weekly/reconcile-rounding',
    {method:'POST'},env)).status,401);
  assert.equal((await route.request('/settlements/op_wb_260927_weekly/reconcile-rebill',
    {method:'POST'},env)).status,401);
  delete env.ERP_RUN_SECRET;
  assert.equal((await request(env)).status,401);
  assert.equal(writes.length,0);
});
test('invalid, reversed and over-31-day windows are rejected before upstream access', async () => {
  const {env,writes} = fixture();
  for (const [a,b] of [['2026-02-30','2026-03-01'],['2026-10-03','2026-10-02'],['2026-09-02','2026-10-03'],['','2026-10-03']]) {
    assert.equal((await request(env,`/goods-returns?dateFrom=${a}&dateTo=${b}`)).status,400);
  }
  assert.equal(writes.length,0);
});
test('31-day report preserves statuses and identifiers and uses the central one-minute rate limit', async (t) => {
  const {env,writes} = fixture();
  const report = [{srid:'fixture-order',isStatusActive:1,status:'Готов к выдаче',completedDt:'',shkId:123}];
  t.mock.method(globalThis,'fetch',async req => {
    const url = new URL(req.url);
    assert.equal(req.method,'GET');
    assert.equal(url.origin,'https://seller-analytics-api.wildberries.ru');
    assert.equal(url.pathname,'/api/v1/analytics/goods-return');
    assert.equal(url.searchParams.get('dateFrom'),'2026-09-03');
    assert.equal(req.headers.get('Authorization'),'wb-fixture');
    return Response.json({report});
  });
  const res = await request(env);
  assert.equal(res.status,200); assert.equal(res.headers.get('Cache-Control'),'no-store');
  assert.deepEqual((await res.json()).report,report);
  const claim = writes.find(w => w.sql.includes('INSERT INTO wb_api_limits'));
  assert.equal(claim.args[1]-claim.args[2],65000);
});
test('throttling, upstream failure, invalid JSON and missing report never become an empty successful report', async (t) => {
  for (const upstream of [new Response('',{status:429,headers:{'Retry-After':'65'}}),new Response('',{status:403}),Response.json({}),new Response('bad-json')]) {
    t.mock.method(globalThis,'fetch',async () => upstream);
    const res = await request(fixture().env);
    assert.equal(res.status,upstream.status===429?429:502);
    const body=await res.json(); assert.equal(body.ok,false); assert.equal(body.report,undefined);
    if (upstream.status===429) assert.equal(res.headers.get('Retry-After'),'65');
    t.mock.restoreAll();
  }
});
test('a verified empty report is distinguishable from an error', async (t) => {
  t.mock.method(globalThis,'fetch',async () => Response.json({report:[]}));
  const res = await request(fixture().env);
  assert.equal(res.status,200); assert.deepEqual((await res.json()).report,[]);
});
