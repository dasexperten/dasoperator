import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url);
const {build}=require('esbuild');
const dir=mkdtempSync(join(tmpdir(),'erp-calendar-'));
const outfile=join(dir,'worker.mjs'), calendar=join(dir,'calendar.mjs');
await build({entryPoints:[fileURLToPath(new URL('./index.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile,
 plugins:[{name:'timer-boundary',setup(b){
 b.onResolve({filter:/_shared\/(trigger-erp|run)$/},a=>({path:a.path,namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path.endsWith('/trigger-erp')?
  'export const erpTriggerWorker=()=>({scheduled:async()=>{globalThis.__calendar.erpCalls++},fetch:async()=>{globalThis.__calendar.manualCalls++;return new Response("manual")}});':
  'export const erpWorker=(_worker,job)=>({scheduled:async(_e,env)=>{globalThis.__calendar.skips.push(await job(env,false,"timer"))}});'}));
 }}]});
await build({entryPoints:[fileURLToPath(new URL('../../../api/src/lib/cron-expect.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:calendar});
const worker=(await import(pathToFileURL(outfile))).default;
const {expectedFires}=await import(pathToFileURL(calendar));
rmSync(dir,{recursive:true});
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const cron=path=>JSON.parse(read(path).match(/^crons\s*=\s*(\[[^\]]*\])/m)[1])[0];
const site=cron('../wrangler.toml'),wb=cron('../../erp-wb-weekly-report/wrangler.toml');
const count=(expression,day)=>expectedFires(expression,new Date(day),new Date(Date.parse(day)+86_400_000)).length;
const fixture=()=>globalThis.__calendar={erpCalls:0,manualCalls:0,skips:[]};
const tick=iso=>worker.scheduled({scheduledTime:Date.parse(iso),cron:site},{},{});

test('WB report fires Thursday, not the previous Wednesday',()=>{
 assert.equal(count(wb,'2026-10-22T00:00:00Z'),1);
 assert.equal(count(wb,'2026-10-21T00:00:00Z'),0);
});
test('site timer is weekly Wednesday with unrestricted day-of-month',()=>{
 assert.equal(site,'0 4 * * 4');
 assert.equal(count(site,'2026-10-21T00:00:00Z'),1);
 assert.equal(count(site,'2026-10-20T00:00:00Z'),0);
 assert.equal(count(site,'2026-10-01T00:00:00Z'),0);
});
test('each first Wednesday reaches ERP exactly once across a full calendar year',async()=>{
 const f=fixture();
 const firsts=['01-07','02-04','03-04','04-01','05-06','06-03','07-01','08-05','09-02','10-07','11-04','12-02'];
 for(const date of firsts)await tick('2026-'+date+'T04:00:00Z');
 assert.equal(f.erpCalls,12);assert.equal(f.skips.length,0);
});
test('later Wednesdays and wrong weekdays are journaled skips without ERP side effects',async()=>{
 const f=fixture();
 for(const date of ['2026-10-14','2026-10-21','2026-10-28','2026-10-01','2026-10-06'])await tick(date+'T04:00:00Z');
 assert.equal(f.erpCalls,0);assert.equal(f.skips.length,5);assert.ok(f.skips.every(r=>r.note.includes(': not due') && r.note.includes('SKIPPED')));
});
test('late delivery uses scheduled time, not the processing day',async t=>{
 const f=fixture();t.mock.method(Date,'now',()=>Date.parse('2026-10-14T04:00:00Z'));
 await tick('2026-10-07T04:00:00Z');assert.equal(f.erpCalls,1);
});
test('explicit manual run keeps its existing behavior on any calendar date',async()=>{
 const f=fixture();const response=await worker.fetch(new Request('https://test/run',{method:'POST'}),{},{});
 assert.equal(await response.text(),'manual');assert.equal(f.manualCalls,1);assert.equal(f.skips.length,0);
});
test('generated expected schedules match both deployed worker configurations',()=>{
 const generated=JSON.parse(read('../../../api/src/generated/erp-schedules.json'));
 assert.deepEqual(generated['erp-site-sales-rebuild'],[site]);assert.deepEqual(generated['erp-wb-weekly-report'],[wb]);
});
