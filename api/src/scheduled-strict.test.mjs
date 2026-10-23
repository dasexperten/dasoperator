import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {transformSync}=require(require.resolve('esbuild',{paths:[process.cwd(),process.cwd()+'/workers']}));
const source=readFileSync(new URL('./scheduled.ts',import.meta.url),'utf8');
// Execute the production dispatch body with isolated service adapters. Only module
// loading is replaced; branches, HTTP checks and catch/finally logic are unchanged.
const start=source.indexOf('export async function handleScheduled('),end=source.indexOf('\n// =============================================================================\n// Marketplace STOCKS sync',start);
const body=source.slice(start,end).replaceAll('await import(', 'await loadModule(');
const names=['runEmailRetention','scheduleWbWeekly','scheduleOzonMonthly','rebuildPriorMonthDasexpertenCom','recordErpRecovery','reportCronFailure','runMarketplaceSync','cronCreatePerfReport'];
const prelude=`const loadModule=async path=>globalThis.__scheduledTest.modules[path]??{};\n`+names.map(n=>`const ${n}=(...args)=>globalThis.__scheduledTest.functions.${n}?.(...args);`).join('\n');
const code=transformSync(prelude+body,{loader:'ts',format:'esm'}).code;
const {handleScheduled}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function fixture(t){
 const deps={modules:{},functions:{},calls:[]};globalThis.__scheduledTest=deps;
 t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});t.mock.method(console,'warn',()=>{});
 const run=(cron,env={},strict=true)=>handleScheduled({cron,scheduledTime:Date.now()},env,{},strict);return {deps,run};
}
test('daily digest non-2xx is a failed run, legacy direct dispatch behavior is preserved',async t=>{
 const {run}=fixture(t),env={SELF:{fetch:async()=>new Response('failed',{status:503})}};
 await assert.rejects(run('0 3 * * *',env),/Daily digest HTTP503|Daily digest HTTP 503/);
 await run('0 3 * * *',env,false);
});
test('an earlier site ingestion failure does not skip the independent abandoned-cart sweep',async t=>{
 const {run,deps}=fixture(t);let swept=0;
 deps.modules['./lib/crm-website']={pollStripeOrders:async()=>{throw Error('orders unavailable')}};
 deps.modules['./lib/crm-carts']={sweepAbandoned:async()=>{swept++;return 1}};
 await assert.rejects(run('7 * * * *'),/orders unavailable/);assert.equal(swept,1);
});
test('Skladbot HTTP/returned errors fail the batch after all independent legs finish',async t=>{
 const {run}=fixture(t);let calls=0;
 const env={SELF:{fetch:async()=>{calls++;if(calls===1)return new Response('failed',{status:500});if(calls===2)return Response.json({success:true,result:{synced:1,total:2,errors:['one missing']}});return Response.json({imported:1})}}};
 await assert.rejects(run('30 */6 * * *',env),/Skladbot HTTP500|Skladbot HTTP 500/);assert.equal(calls,4);
});
test('watchdog failure still lets cron failure reconciliation run',async t=>{
 const {run,deps}=fixture(t);let reconciled=0;
 deps.modules['./lib/watchdog']={runWatchdog:async()=>{throw Error('watchdog unavailable')}};
 deps.modules['./lib/erp-cron-failures']={notifyErpCronFailures:async()=>{reconciled++;return 0}};
 await assert.rejects(run('*/10 * * * *'),/watchdog unavailable/);assert.equal(reconciled,1);
});
test('one failed analytics leg prevents claiming overall recovery',async t=>{
 const {run,deps}=fixture(t);let recovery=0;
 deps.modules['./lib/web-analytics-sync']={runWebAnalyticsNightly:async()=>({date:'today',legs:['ga4: done','clarity: FAILED (503)']})};
 deps.functions.recordErpRecovery=async()=>{recovery++};
 await assert.rejects(run('30 2 * * *'),/clarity: FAILED/);assert.equal(recovery,0);
});
test('auto-delivery business skips remain successful; technical patch failures do not',async t=>{
 const {run,deps}=fixture(t);let reason='fbo_insufficient';
 deps.modules['./auto-delivery']={runAutoDeliverySweep:async()=>({scanned:1,delivered:[],skipped:[{id:'one',reason}]})};
 await run('0 */4 * * *');reason='network_error: disconnected';
 await assert.rejects(run('0 */4 * * *'),/network_error/);
});
test('pulse rejects missing result instead of reporting three cached endpoints',async t=>{
 const {run}=fixture(t);let cached=0;
 await assert.rejects(run('0 1 * * *',{SELF:{fetch:async()=>Response.json({success:true})},CACHE:{put:async()=>{cached++}}}),/Pulse response incomplete/);assert.equal(cached,0);
});
test('successful dispatch resolves and unknown strict dispatch fails',async t=>{
 const {run}=fixture(t);await run('0 3 * * *',{SELF:{fetch:async()=>new Response('done')}});
 await assert.rejects(run('unknown'),/No scheduled handler/);
});
test('returned mail-retention errors fail the scheduled run',async t=>{
 const {run,deps}=fixture(t);deps.functions.runEmailRetention=async()=>({errors:['archive unavailable']});
 await assert.rejects(run('0 3 1 * *'),/archive unavailable/);
});
test('nested importer partial failure cannot be reported as zero successful work',async t=>{
 const {run}=fixture(t);let calls=0;
 const env={SELF:{fetch:async()=>{calls++;return Response.json(calls===1?{success:true,result:{synced:[]}}:calls===2?{success:true,result:{synced:0,total:0,errors:[]}}:calls===3?{success:true,result:{processed:1,results:[{reason:'insert_failed_DB'}]}}:{ok:true,imported:1,units:2,results:[{reason:'imported'}]})}}};
 await assert.rejects(run('30 */6 * * *',env),/partial import failed/);assert.equal(calls,4);
});
