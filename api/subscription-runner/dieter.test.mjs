import test from 'node:test';import assert from 'node:assert/strict';
import {dieterPrompt,runDieterProcess} from './dieter.mjs';
test('only an exact accepted job can become a work prompt',()=>{
 assert.throws(()=>dieterPrompt({mode:'work'},'/repo'),/exact_dieter_assignment/);
 assert.throws(()=>dieterPrompt({mode:'other'},'/repo'),/invalid_dieter_mode/);
 const p=dieterPrompt({mode:'work',assignment:{content_id:'chosen',claim_id:'lease',status:'working',task:'ACTUAL ASSIGNMENT'}},'/repo');
 assert.ok(p.includes('ACTUAL ASSIGNMENT'));assert.ok(p.includes('gpt-6.1-terra'));assert.ok(p.includes('never claim another job'));assert.ok(p.includes('No Jev, desktop/local-machine dependency'));assert.ok(p.includes('do not attempt them in this round'));assert.ok(p.includes('it is not enabled now'));
});
test('the two recovery attempts cannot upload again',()=>{
 const p=dieterPrompt({mode:'reconcile',assignment:{content_id:'chosen',claim_id:'lease',status:'working',task:'Reconcile'}},'/repo');
 assert.match(p,/MUST NOT create any new upload, container, post or publication/);assert.match(p,/No release or another claim/);
});

test('no-input tools have no stdin pipe and finish normally',async()=>{
 const {spawn}=await import('node:child_process');let calls=0;
 const out=await runDieterProcess(process.execPath,['-e',"process.stdout.write('probe-ok')"],undefined,{spawnImpl:(cmd,args,options)=>{calls++;assert.equal(options.stdio[0],'ignore');const child=spawn(cmd,args,options);assert.equal(child.stdin,null);return child;}});
 assert.equal(out,'probe-ok');assert.equal(calls,1);
});
test('early child stdin closure is a bounded failure, not a server crash or replay',async()=>{
 const {spawn}=await import('node:child_process');let calls=0;
 await assert.rejects(runDieterProcess(process.execPath,['-e',"require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),100)"],'x'.repeat(4000000),{spawnImpl:(cmd,args,options)=>{calls++;return spawn(cmd,args,options);},timeout:2000}),/dieter_process_stdin_failed/);
 assert.equal(calls,1);
 assert.equal(await runDieterProcess(process.execPath,['-e',"process.stdout.write('still-alive')"]),'still-alive');
});
