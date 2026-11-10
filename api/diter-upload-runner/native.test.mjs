import test from 'node:test';import assert from 'node:assert/strict';import {nativeInfer} from './native.mjs';
test('no Diana inference or model above Terra can run',async()=>{
 for(const operation of ['image','context','reply'])await assert.rejects(nativeInfer({operation,model:'gpt-6.1-terra'}),/invalid_request/);
 await assert.rejects(nativeInfer({operation:'dieter_round',model:'gpt-6-astra'}),/invalid_request/);
 await assert.rejects(nativeInfer({operation:'dieter_round',model:'gpt-6.1-terra'},{auth:{auth_mode:'api_key'}}),/subscription_auth_required/);
});
test('fixed long diagnostic uses synthetic child only, no stdin/key/model',async()=>{
 const {runtimeProbe}=await import('./native.mjs');const {EventEmitter}=await import('node:events');let called=0;const times=[0,180001];
 const result=await runtimeProbe('runtime-probe:synthetic',{now:()=>times.shift(),spawnImpl:(cmd,args,options)=>{called++;assert.equal(cmd,process.execPath);assert.deepEqual(args,['-e',"setTimeout(()=>process.stdout.write('DIETER_FIXED_PROBE_COMPLETE'),180000)"]);assert.equal(options.stdio[0],'ignore');assert.deepEqual(Object.keys(options.env),['PATH']);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};queueMicrotask(()=>{child.stdout.emit('data','DIETER_FIXED_PROBE_COMPLETE');child.emit('close',0);});return child;}});assert.equal(called,1);assert.equal(result.receipt.elapsed_ms,180001);assert.equal(result.receipt.model_invocations,0);assert.equal(result.receipt.auth,'none');
});
