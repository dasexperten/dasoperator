import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { wbRead, wbEgress } from '../../../workers/_marketplace/wb-egress.mjs';
const require = createRequire(import.meta.url);
const { transformSync } = require(require.resolve('esbuild', { paths: [process.cwd(), join(process.cwd(), 'workers')] }));
const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
async function compile(path, name) {
  writeFileSync(join(dir, name+'.mjs'), transformSync(readFileSync(path, 'utf8'), { loader:'ts', format:'esm' }).code);
  return import(pathToFileURL(join(dir, name+'.mjs')));
}
const { wbRequest, wbPolicy, retryMilliseconds } = await compile(new URL('./wb-gateway.ts', import.meta.url), 'gateway');
const { runLogged } = await compile(new URL('../../../workers/_shared/run.ts', import.meta.url), 'runs');
const { runFboSync } = await compile(new URL('../marketplaces/fbo-sync.ts', import.meta.url), 'fbo');
let sequence = 0;
function database() {
  const path = join(dir, `db-${sequence++}.sqlite`);
  function sql(query, args = [], script = false) {
    const p = spawnSync('python3', ['-c', `import sqlite3,json,sys
q,a,script=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if script: c.executescript(q); rows=[]
else: rows=[dict(r) for r in c.execute(q,a).fetchall()]
c.commit();print(json.dumps(rows))`, path], { input:JSON.stringify([query,args,script]), encoding:'utf8' });
    if (p.status) throw new Error(p.stderr);
    return JSON.parse(p.stdout);
  }
  sql(readFileSync(new URL('../../../db/migrations/20260919_wb_gateway.sql',import.meta.url),'utf8')+`
    CREATE TABLE erp_cron_runs (id INTEGER PRIMARY KEY, worker TEXT, cron TEXT, started_at TEXT, dry_run INTEGER, finished_at TEXT, ok INTEGER, rows INTEGER, note TEXT, error TEXT);`,[],true);
  return { prepare(query) { let args=[]; return { bind(...a){args=a;return this;}, async first(){return sql(query,args)[0]??null;}, async run(){return sql(query,args);} }; } };
}
const url = 'https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=2026-09-01';
test('gateway denies SSRF and care hosts; honours server retry headers',()=>{
  for (const u of ['https://evil.example/', 'https://statistics-api.wildberries.ru.evil.test/', 'http://statistics-api.wildberries.ru/', 'https://feedbacks-api.wildberries.ru/api/v1/questions', 'https://x:y@statistics-api.wildberries.ru/']) assert.throws(()=>wbPolicy(new URL(u)));
  assert.equal(retryMilliseconds(new Headers({'X-Ratelimit-Retry':'719'})),719000);
  assert.equal(retryMilliseconds(new Headers({'Retry-After':'120'})),120000);
});
test('concurrent calls spend one slot, inject ERP credential and forbid redirects',async(t)=>{
  const env={ DB:database(),WB_API_TOKEN:'test-erp-only'};
  let calls=0;
  t.mock.method(globalThis,'fetch',async request=>{
    calls++; assert.equal(request.headers.get('Authorization'),'test-erp-only');assert.equal(request.redirect,'manual');
    return Response.json([]);
  });
  const res=await Promise.all([wbRequest(env,url),wbRequest(env,url)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,429]);assert.equal(calls,1);
  assert.equal((await wbRequest(env,url)).status,429);assert.equal(calls,1);
});
test('upstream 429 persists across callers without another WB request',async(t)=>{
 const env={DB:database(),WB_API_TOKEN:'test-token'};let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('limited',{status:429,headers:{'X-Ratelimit-Retry':'719'}});});
 await wbRequest(env,url);const r=await wbRequest(env,url);
 assert.equal(calls,1);assert.ok(Number(r.headers.get('Retry-After'))>=719);
});
test('client has no direct fallback and retries are bounded',async()=>{
 await assert.rejects(()=>wbEgress({},url),/binding missing/);
 let calls=0;const sleeps=[];
 const env={WB_GATEWAY:{fetch:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'1'}});}}};
 const r=await wbRead(env,url,{}, {attempts:3,sleep:async ms=>sleeps.push(ms)});
 assert.equal(r.status,429);assert.equal(calls,3);assert.deepEqual(sleeps,[2000,2000]);
 calls=0;env.WB_GATEWAY.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'719'}});};
 await wbRead(env,url);assert.equal(calls,1);
});
test('scheduled duplicate and overlapping manual run do not execute a second job',async()=>{
 const env={DB:database()};let calls=0;let release;
 const waiting=new Promise(r=>release=r);
 const first=runLogged(env,'erp-wb-sales','15 22 * * *',async()=>{calls++;await waiting;return {rows:31};},1234);
 await new Promise(r=>setTimeout(r,10));
 const concurrent=await runLogged(env,'erp-wb-sales','manual',async()=>{calls++;return {};});
 assert.match(concurrent.note,/already running/);release();await first;
 const duplicate=await runLogged(env,'erp-wb-sales','15 22 * * *',async()=>{calls++;return {};},1234);
 assert.match(duplicate.note,/already handled/);assert.equal(calls,1);
});
test('WB FBO requests cannot touch a database or network',async(t)=>{
 t.mock.method(globalThis,'fetch',()=>{throw new Error('unexpected network');});
 const report=await runFboSync({},'wb');assert.equal(report.wb.skipped,true);
});
