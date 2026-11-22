import './no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandoffRecoveryJournal } from './handoff-recovery.mjs';
import { config,candidate,observation,verifyNetworkDenied } from './handoff-recovery.fixture-worker.mjs';
const read={agent:'angela',reservationId:'fixture-reservation'};
function fixture(t) {
 const directory=mkdtempSync(join(tmpdir(),'handoff-recovery-fixture-')),path=join(directory,'journal.sqlite');
 const db=new DatabaseSync(path);
 db.exec(readFileSync(new URL('./handoff-recovery.schema.sql',import.meta.url),'utf8'));db.close();
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 return path;
}
function open(path) {
 const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=3000');
 return {db,j:createHandoffRecoveryJournal({config,db})};
}
async function compete(path,specs) {
 const gate=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),workers=[];
 try {
  const jobs=specs.map(spec=>{
   const worker=new Worker(new URL('./handoff-recovery.fixture-worker.mjs',import.meta.url),{
    execArgv:['--import',new URL('./no-network.mjs',import.meta.url).href],workerData:{path,gate,...spec},
   });workers.push(worker);
   let readyResolve,readyReject,doneResolve,doneReject,results,readySeen=false;
   const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
   const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
   // Attach rejection handlers immediately, including while waiting for readiness.
   done.catch(()=>{});ready.catch(()=>{});
   const timer=setTimeout(()=>{
    const error=Error('fixture_worker_timeout');readyReject(error);doneReject(error);void worker.terminate();
   },10000);
   worker.on('message',message=>{
    if(message.ready) {readySeen=true;assert.equal(message.networkDenied,true);readyResolve();}
    if(message.results) results=message.results;
   });
   worker.on('error',error=>{readyReject(error);doneReject(error);});
   worker.on('exit',code=>{
    clearTimeout(timer);
    if(!readySeen||code!==0) {const error=Error(`fixture_worker_exit_${code}`);readyReject(error);doneReject(error);}
    else if(!spec.dropResponse&&!results) doneReject(Error('fixture_result_missing'));
    else doneResolve(results??null);
   });
   return {ready,done};
  });
  await Promise.all(jobs.map(j=>j.ready));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);
  return await Promise.all(jobs.map(j=>j.done));
 } finally {await Promise.all(workers.map(worker=>worker.terminate()));}
}
test('independent file connections converge on one fence; stale competing observations never overwrite',{timeout:20000},async t=>{
 await verifyNetworkDenied();const path=fixture(t),input=candidate();
 const reservations=await compete(path,Array.from({length:4},()=>({requests:[{method:'reserve',input}]})));
 assert.ok(reservations.every(r=>r[0].ok));assert.equal(reservations.filter(r=>r[0].result.replay===false).length,1);
 assert.equal(reservations.filter(r=>r[0].result.replay===true).length,3);
 const conflict=await compete(path,[{requests:[{method:'reserve',input:{...input,reservationId:'different-attempt'}}]}]);
 assert.equal(conflict[0][0].ok,false);assert.match(conflict[0][0].error,/reservation_conflict/);
 const observations=await compete(path,[0,1].map(i=>({requests:[{method:'observe',input:observation(0,`contender-${i}`)}]})));
 assert.equal(observations.filter(r=>r[0].ok).length,1);assert.equal(observations.filter(r=>!r[0].ok).length,1);
 assert.match(observations.find(r=>!r[0].ok)[0].error,/stale_sequence|observation_conflict/);
 const {db,j}=open(path);try {
  assert.equal(j.read(read).sequence,1);assert.equal(j.read(read).manualStage,'');
  assert.equal(db.prepare('SELECT count(*) n FROM pilot_handoff_reservations').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM pilot_handoff_observations').get().n,1);
 } finally {db.close();}
});
test('worker commit then silent exit recovers the same ERP mapping and permanent fence on file reopen',{timeout:20000},async t=>{
 await verifyNetworkDenied();const path=fixture(t),input=candidate();
 const identified=observation(0,'fixture-identification','erp_identified','fixture-opaque-erp');
 const failedAck=observation(1,'fixture-sheet-failure','sheet_ack_failed','fixture-opaque-erp');
 const lost=await compete(path,[{dropResponse:true,requests:[{method:'reserve',input},{method:'observe',input:identified},{method:'observe',input:failedAck}]}]);
 assert.deepEqual(lost,[null]);
 let opened=open(path);
 try {
  const replay=opened.j.reserve(input);assert.equal(replay.replay,true);assert.equal(replay.erpCaseId,'fixture-opaque-erp');
  assert.equal(replay.status,'sheet_ack_failed');assert.equal(replay.manualStage,'');
  assert.equal(opened.j.observe(identified).replay,true);assert.equal(opened.j.observe(failedAck).replay,true);
  assert.throws(()=>opened.j.reserve({...input,reservationId:'new-attempt-after-restart'}),/reservation_conflict/);
  assert.throws(()=>opened.j.observe(observation(2,'new-case','erp_identified','different-erp')),/erp_identity_immutable/);
 } finally {opened.db.close();}
 opened=open(path);try {
  assert.equal(opened.j.read(read).sequence,2);assert.equal(opened.j.read(read).erpCaseId,'fixture-opaque-erp');
  assert.equal(opened.db.prepare('SELECT count(*) n FROM pilot_handoff_reservations').get().n,1);
  assert.equal(opened.db.prepare('SELECT count(*) n FROM pilot_handoff_observations').get().n,2);
  const ack=opened.j.observe(observation(2,'same-mapping-ack','sheet_acknowledged','fixture-opaque-erp'));
  assert.equal(ack.erpCaseId,'fixture-opaque-erp');assert.equal(ack.executionAuthorized,false);
 } finally {opened.db.close();}
});
