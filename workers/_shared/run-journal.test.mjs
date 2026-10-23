import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'erp-api-journal-'));
await build({entryPoints:[fileURLToPath(new URL('./run-journal.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'journal.mjs')});
const {runApiStep,finishTimerRun,readRun}=await import(pathToFileURL(join(dir,'journal.mjs')));
await build({entryPoints:[fileURLToPath(new URL('./run.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'run.mjs')});
const {erpWorker}=await import(pathToFileURL(join(dir,'run.mjs')));
const routeFile=fileURLToPath(new URL('../../api/src/routes/internal-cron.ts',import.meta.url));
await build({entryPoints:[routeFile],bundle:true,platform:'node',format:'esm',outfile:join(dir,'route.mjs'),plugins:[{name:'isolated-jobs',setup(b){
 b.onResolve({filter:/^\.\.\/(scheduled|cron-steps)$/},args=>args.importer===routeFile?{path:args.path,namespace:'jobs'}:undefined);
 b.onLoad({filter:/.*/,namespace:'jobs'},args=>({contents:args.path.endsWith('scheduled')
  ? `export async function handleScheduled(event,env){env.calls.push(event.cron);if(env.fail)throw Error('job failed')}`
  : `export const STEPS={'erp-test':async(env)=>{env.calls.push('step');if(env.fail)throw Error('job failed');return 'work complete'}};`,loader:'js'}));
 b.onResolve({filter:/^\.\.\/lib\//},args=>args.importer===routeFile?{path:args.path,external:true}:undefined);
}}]});
const route=(await import(pathToFileURL(join(dir,'route.mjs')))).default;
let sequence=0;
function database(t, failure={}) {
 const path=join(dir,`db-${sequence++}.sqlite`);t.after(()=>rmSync(path,{force:true}));let failures=0;
 function sql(query,args=[],script=false){
  const p=spawnSync('python3',['-c',`import sqlite3,json,sys
q,a,script=json.load(sys.stdin)
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if script:c.executescript(q);rows=[]
else:rows=[dict(r) for r in c.execute(q,a).fetchall()]
changes=c.execute('SELECT changes()').fetchone()[0]
c.commit();print(json.dumps({'success':True,'results':rows,'meta':{'changes':changes}}))`,path],{input:JSON.stringify([query,args,script]),encoding:'utf8'});
  if(p.status)throw Error(p.stderr);return JSON.parse(p.stdout);
 }
 for(const file of ['0091_erp_cron_runs.sql','0137_erp_cron_run_key.sql','0138_erp_cron_api_owner.sql','0139_erp_cron_schedule_source.sql','0140_erp_cron_local_owner.sql'])sql(readFileSync(new URL('../../db/migrations/'+file,import.meta.url),'utf8'),[],true);
 const db={sql,prepare(query){let args=[];return {bind(...a){args=a;return this},async first(){return sql(query,args).results[0]??null},async run(){
  const match=failure.match?.test(query)&&failures<(failure.times??1);
  if(match&&failure.before){failures++;throw Error('Network connection lost')}
  const r=sql(query,args);if(match){failures++;throw Error('Network connection lost')}return r;
 }}}};
 db.add=(key='key',worker='erp-test')=>sql("INSERT INTO erp_cron_runs(run_key,worker,cron,started_at) VALUES(?,?,?,?)",[key,worker,'timer',new Date().toISOString()]);return db;
}
const phase=()=>{};
test('API completion survives a lost caller response and cannot be overwritten',async t=>{
 const db=database(t);db.add();let calls=0;
 assert.equal((await runApiStep(db,'erp-test','key',async()=>{calls++;return 'actual work'},phase)).ok,true);
 const finished=await finishTimerRun(db,'key',{ok:false,error:'transport disconnected'},phase);
 assert.deepEqual(finished,{state:'finished',outcome:{ok:true,note:'actual work'},apiOwned:true});
 assert.equal((await runApiStep(db,'erp-test','key',async()=>{calls++;return 'duplicate'},phase)).note,'actual work');assert.equal(calls,1);
});
test('caller timeout while API owns the row stays unknown; later actual result wins',async t=>{
 const db=database(t);db.add();let release,entered;
 const started=new Promise(r=>entered=r),work=new Promise(r=>release=r);
 const api=runApiStep(db,'erp-test','key',async()=>{entered();await work;return 'done'},phase);await started;
 assert.equal((await finishTimerRun(db,'key',{ok:false,error:'transport'},phase)).state,'api_pending');
 assert.equal((await readRun(db,'key')).finished_at,null);
 const dupe=await runApiStep(db,'erp-test','key',async()=>assert.fail('duplicate job'),phase);assert.equal(dupe.pending,true);
 release();await api;assert.equal((await readRun(db,'key')).ok,1);
 assert.equal(db.sql('SELECT transport_error FROM erp_cron_runs').results[0].transport_error,'transport');
});
test('a caller finish before API acceptance prevents the late job',async t=>{
 const db=database(t);db.add();await finishTimerRun(db,'key',{ok:false,error:'not accepted'},phase);
 const result=await runApiStep(db,'erp-test','key',async()=>assert.fail('late job'),phase);
 assert.equal(result.ok,false);assert.equal(result.error,'not accepted');
});
for(const failure of [{match:/SET api_owner/,name:'claim'}, {match:/SET finished_at/,name:'completion'}])test('lost '+failure.name+' acknowledgement does not replay the step',async t=>{
 const db=database(t,failure);db.add();let calls=0;
 const result=await runApiStep(db,'erp-test','key',async()=>{calls++;return 'once'},phase);
 assert.equal(result.ok,true);assert.equal(calls,1);assert.equal((await readRun(db,'key')).ok,1);
});
test('lost timer terminal acknowledgement returns its persisted outcome',async t=>{
 const db=database(t,{match:/SET finished_at/});db.add();
 assert.equal((await finishTimerRun(db,'key',{ok:true,note:'done'},phase)).outcome.ok,true);
});
test('permanent claim failure or missing/mismatched row never executes work',async t=>{
 const db=database(t);db.add('key','other-worker');
 for(const key of ['missing','key'])await assert.rejects(runApiStep(db,'erp-test',key,async()=>assert.fail('untracked job'),phase),/missing or worker mismatch/);
});
test('exhausted pre-write claim failure prevents work',async t=>{
 const db=database(t,{match:/SET api_owner/,times:3,before:true});db.add();let calls=0;
 await assert.rejects(runApiStep(db,'erp-test','key',async()=>{calls++;return 'bad'},phase),/Network/);assert.equal(calls,0);
 assert.equal((await readRun(db,'key')).api_owner,null);assert.equal((await readRun(db,'key')).finished_at,null);
});
test('API job error is terminal and duplicate delivery does not retry it',async t=>{
 const db=database(t);db.add();let calls=0;
 const job=async()=>{calls++;throw Error('failed part')};
 assert.equal((await runApiStep(db,'erp-test','key',job,phase)).error,'failed part');
 assert.equal((await runApiStep(db,'erp-test','key',job,phase)).ok,false);assert.equal(calls,1);
});
test('exhausted API completion writes retain ownership and suppress caller replay',async t=>{
 const db=database(t,{match:/SET finished_at/,times:3,before:true});db.add();let calls=0;
 await assert.rejects(runApiStep(db,'erp-test','key',async()=>{calls++;return 'effect done'},phase));
 assert.equal((await finishTimerRun(db,'key',{ok:false,error:'API journal unavailable'},phase)).state,'api_pending');assert.equal(calls,1);
});
test('scheduled API-pending result calls noRetry and is visibly unsuccessful',async t=>{
 const db=database(t);let pending,noRetry=0;const logs=[];t.mock.method(console,'log',s=>logs.push(s));
 const worker=erpWorker('erp-test',async(env,_dry,_cron,ctx)=>{
  db.sql('UPDATE erp_cron_runs SET api_owner=?,api_started_at=? WHERE run_key=?',['owner','now',ctx.runKey]);throw Error('transport');
 });
 await worker.scheduled({cron:'timer',scheduledTime:1,noRetry(){noRetry++}},{DB:db},{waitUntil(p){pending=p}});
 await assert.rejects(pending,/completion not yet confirmed/);assert.equal(noRetry,1);
 assert.ok(logs.some(s=>s.includes('api_completion_pending')));
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));

for (const match of [/SET api_owner/, /SET finished_at/]) test('exhausted lost acknowledgements use durable readback: '+match,async t=>{
 const db=database(t,{match,times:3});db.add();let calls=0;
 const out=await runApiStep(db,'erp-test','key',async()=>{calls++;return 'confirmed'},phase);
 assert.equal(out.ok,true);assert.equal(calls,1);assert.equal((await readRun(db,'key')).ok,1);
});
test('timer exhausted lost terminal acknowledgements read back success',async t=>{
 const db=database(t,{match:/SET finished_at/,times:3});db.add();
 assert.equal((await finishTimerRun(db,'key',{ok:true,note:'confirmed'},phase)).outcome.ok,true);
});

for (const worker of ['erp-test','erp-web-analytics']) test('HTTP '+worker+' owns and persists actual result before returning',async t=>{
 const db=database(t),key=crypto.randomUUID();db.add(key,worker);const env={DB:db,ERP_RUN_SECRET:'fixture',calls:[]};const waits=[];
 const request=()=>new Request('https://internal/'+worker,{method:'POST',headers:{Authorization:'Bearer fixture','X-Erp-Run-Key':key,'X-Erp-Trigger-Source':'external_clock'}});
 const ctx={waitUntil(p){waits.push(p)}};
 assert.equal((await route.fetch(request(),env,ctx)).status,200);
 assert.equal((await route.fetch(request(),env,ctx)).status,200);await Promise.all(waits);
 assert.equal(env.calls.length,1);assert.ok((await readRun(db,key)).api_owner);assert.equal((await readRun(db,key)).ok,1);
 assert.equal(db.sql('SELECT api_trigger_source FROM erp_cron_runs').results[0].api_trigger_source,'external_clock');
});
test('HTTP legacy caller works without journal; invalid/missing key cannot execute tracked work',async t=>{
 const db=database(t),env={DB:db,ERP_RUN_SECRET:'fixture',calls:[]},ctx={waitUntil(){}};
 const invoke=key=>route.fetch(new Request('https://internal/erp-test',{method:'POST',headers:{Authorization:'Bearer fixture',...(key?{'X-Erp-Run-Key':key}:{})}}),env,ctx);
 assert.equal((await invoke()).status,200);assert.equal(env.calls.length,1);
 assert.equal((await invoke('invalid')).status,400);assert.equal((await invoke(crypto.randomUUID())).status,500);assert.equal(env.calls.length,1);
});
test('HTTP in-flight duplicate returns409 without another effect',async t=>{
 const db=database(t),key=crypto.randomUUID();db.add(key);db.sql('UPDATE erp_cron_runs SET api_owner=? WHERE run_key=?',['other',key]);
 const env={DB:db,ERP_RUN_SECRET:'fixture',calls:[]};
 const res=await route.fetch(new Request('https://internal/erp-test',{method:'POST',headers:{Authorization:'Bearer fixture','X-Erp-Run-Key':key}}),env,{waitUntil(){}});
 assert.equal(res.status,409);assert.equal((await res.json()).pending,true);assert.equal(env.calls.length,0);
});

test('API-owned partial failure suppresses platform replay of completed independent legs',async t=>{
 const db=database(t);let pending,noRetry=0,work=0;t.mock.method(console,'log',()=>{});
 const worker=erpWorker('erp-test',async(env,_dry,_cron,ctx)=>{
  await runApiStep(db,'erp-test',ctx.runKey,async()=>{work++;throw Error('partial failure')},phase);throw Error('HTTP500');
 });
 await worker.scheduled({cron:'timer',scheduledTime:1,noRetry(){noRetry++}},{DB:db},{waitUntil(p){pending=p}});
 await assert.rejects(pending,/partial failure/);assert.equal(noRetry,1);assert.equal(work,1);
});
