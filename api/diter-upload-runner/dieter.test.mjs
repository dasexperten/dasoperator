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

test('accepted ID completion and original source acquisition are explicit',()=>{const p=dieterPrompt({mode:'work',assignment:{content_id:'c',claim_id:'k',status:'working',task:'upload'}},'/repo');assert.match(p,/upload-accepted callback with its exact provider ID/);assert.match(p,/has provider acceptance with its exact saved ID/);assert.match(p,/public verified requires an actual public readback/);assert.doesNotMatch(p,/has public proof and ERP readback/);assert.match(p,/Apify API/);assert.match(p,/yt-dlp for YouTube/);});

test('CLI uses the scoped Responses door, zero stream/request retries and no desktop OAuth',async()=>{
 const {runDieter}=await import('./dieter.mjs');const {mkdtemp,mkdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {EventEmitter}=await import('node:events');
 const dir=await mkdtemp(join(tmpdir(),'dieter-provider-test-'));await mkdir(join(dir,'auth'));let cli;
 const spawnImpl=(cmd,args,opts)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};child.stdin=new EventEmitter();child.stdin.end=()=>{};queueMicrotask(()=>{let out='probe\n';if(cmd==='git'&&args.includes('rev-parse'))out='synthetic-sha';if(cmd==='codex'&&args.includes('exec')){cli={args,env:opts.env};out=[{type:'item.completed',item:{type:'command_execution',exit_code:0,aggregated_output:'DIETER_CLOUD_TOOLS_READY'}},{type:'item.completed',item:{type:'agent_message',text:'READY'}},{type:'turn.completed'}].map(JSON.stringify).join('\n');}child.stdout.emit('data',out);child.emit('close',0);});return child;};
 try{const result=await runDieter({model:'gpt-6.1-terra',subscriptionDoorKey:'synthetic-door',execution:{mode:'preflight',githubToken:'synthetic-github',serviceSecret:'synthetic-callback'}},{dir,home:join(dir,'auth'),spawnImpl});assert.ok(cli.args.includes('model_provider="dieter_subscription"'));for(const field of ['request_max_retries=0','stream_max_retries=0','supports_websockets=false','requires_openai_auth=false'])assert.ok(cli.args.some(x=>x.endsWith(field)));assert.ok(!cli.args.some(x=>x.includes('forced_login_method')));assert.equal(cli.env.DIETER_SUBSCRIPTION_DOOR_KEY,'synthetic-door');assert.equal(result.receipt.auth,'subscription');assert.ok(!JSON.stringify(result).includes('synthetic-door'));}finally{await rm(dir,{recursive:true,force:true});}
});
