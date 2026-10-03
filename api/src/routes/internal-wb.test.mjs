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
    assert.equal(url.pathname,'/api/analytics/v1/item-returns');
    assert.equal(url.searchParams.get('dateFrom'),'2026-09-03');
    assert.equal(req.headers.get('Authorization'),'wb-fixture');
    return Response.json({count:report.length,report});
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
  t.mock.method(globalThis,'fetch',async () => Response.json({count:0,report:[]}));
  const res = await request(fixture().env);
  assert.equal(res.status,200); assert.deepEqual((await res.json()).report,[]);
});


test('invalid pagination and status never reach WB', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  for (const suffix of ['&status=all','&limit=0','&limit=1001','&limit=1.2','&offset=-1','&offset=9007199254740992','&limit=','&offset=']) {
    const {env,writes}=fixture();
    assert.equal((await request(env,path+suffix)).status,400);
    assert.equal(writes.length,0);
  }
});
test('explicit pagination preserves active filter, total and continuation across pages', async (t) => {
  const rows=[{srid:'one',status:'Готов к выдаче'},{srid:'two',status:'В пути'},{srid:'three',status:'Готов к выдаче'}];
  t.mock.method(globalThis,'fetch',async req => {
    const u=new URL(req.url), start=Number(u.searchParams.get('offset'));
    assert.equal(u.searchParams.get('status'),'active');
    assert.equal(u.searchParams.get('limit'),'2');
    return Response.json({count:3,report:rows.slice(start,start+2)});
  });
  const a=await (await request(fixture().env,path+'&status=active&limit=2&offset=0')).json();
  assert.equal(a.count,3); assert.equal(a.has_more,true); assert.equal(a.complete,false); assert.equal(a.next_offset,2);
  const b=await (await request(fixture().env,path+'&status=active&limit=2&offset='+a.next_offset)).json();
  assert.equal(b.has_more,false); assert.equal(b.complete,false); assert.equal(b.next_offset,null);
  assert.deepEqual([...a.report,...b.report],rows);
});
test('unpaginated consumers cannot silently mistake a partial report for complete', async (t) => {
  t.mock.method(globalThis,'fetch',async req => {
    const u=new URL(req.url);
    assert.equal(u.searchParams.get('status'),null);
    assert.equal(u.searchParams.get('limit'),'1000'); assert.equal(u.searchParams.get('offset'),'0');
    return Response.json({count:1001,report:Array.from({length:1000},(_,i)=>({shkId:i}))});
  });
  const res=await request(fixture().env), body=await res.json();
  assert.equal(res.status,409); assert.equal(body.ok,false); assert.equal(body.complete,false); assert.equal(body.report,undefined);
});
test('204 is a verified empty result, while missing or inconsistent count is an error', async (t) => {
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:204}));
  const res=await request(fixture().env),body=await res.json();
  assert.equal(res.status,200); assert.equal(body.count,0); assert.equal(body.complete,true); assert.deepEqual(body.report,[]);
  t.mock.restoreAll();
  for (const payload of [{report:[]},{count:-1,report:[]},{count:2,report:[]},{count:0,report:[{}]},{count:1.5,report:[]}]) {
    t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
    assert.equal((await request(fixture().env)).status,502);
    t.mock.restoreAll();
  }
});
