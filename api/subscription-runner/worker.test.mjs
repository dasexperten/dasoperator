import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
let source=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
source=source.replace("import { Container } from '@cloudflare/containers';","class Container {constructor(ctx,env){this.ctx=ctx;this.env=env;} containerFetch(...args){if(args[0]==='http://container/health'&&!this.env.startAndWaitForPorts)return new Response('ok');return this.env.containerFetch(...args);} startAndWaitForPorts(...args){return this.env.startAndWaitForPorts?.(...args);}}").replace("import { WorkerEntrypoint } from 'cloudflare:workers';","class WorkerEntrypoint {}");
const {CodexRunner,DirectInferenceService,InferenceService,DieterExecutionService,default:handler}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function setup(){const map=new Map();const ctx={storage:{get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),list:async({prefix})=>new Map([...map].filter(([k])=>k.startsWith(prefix)))}};return {map,ctx};}
test('public admin endpoint denies when key is absent, including Bearer undefined',async()=>{assert.equal((await handler.fetch(new Request('https://example/auth',{headers:{Authorization:'Bearer undefined'}}),{})).status,404);});
test('singleton serializes refreshed auth, keeps encrypted storage and never returns credentials',async()=>{
 const {ctx,map}=setup();const seen=[];let active=0,max=0;
 const env={AUTH_KEY:Buffer.alloc(32,7).toString('base64'),containerFetch:async request=>{
  active++;max=Math.max(max,active);const b=await request.json();seen.push(b.auth.tokens.refresh_token);await new Promise(r=>setTimeout(r,5));active--;
  return Response.json({text:'{}',auth:{auth_mode:'chatgpt',tokens:{refresh_token:b.auth.tokens.refresh_token+'-new'}},receipt:{model:b.model}});
 }};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture-secret'}});
 const body={requestId:'one',operation:'context',model:'gpt-6-luna',messages:[]};
 const rs=await Promise.all([runner.infer(body),runner.infer({...body,requestId:'two'})]);
 assert.equal(max,1);assert.deepEqual(seen,['fixture-secret','fixture-secret-new']);for(const r of rs)assert.equal((await r.json()).auth,undefined);
 assert.ok(!JSON.stringify([...map]).includes('fixture-secret'));
 await runner.infer(body);assert.equal(seen.length,2);
 assert.equal((await runner.infer({...body,messages:['different']})).status,409);
});
test('a lost tool-round outcome cannot execute a second upload round',async()=>{
 const {ctx}=setup();let calls=0;
 const env={AUTH_KEY:Buffer.alloc(32,9).toString('base64'),containerFetch:async()=>{calls++;throw Error('connection lost after request');}};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const body={requestId:'dieter-claim-0',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}};
 await assert.rejects(runner.infer(body),/connection lost/);
 assert.equal((await runner.infer(body)).status,409);assert.equal(calls,1);
 assert.equal((await runner.infer({...body,model:'gpt-6-luna'})).status,400);
});
test('container failure exposes only closed diagnostic fields and never retries work',async()=>{
 const {ctx}=setup();let calls=0;
 const env={AUTH_KEY:Buffer.alloc(32,6).toString('base64'),containerFetch:async()=>{calls++;return Response.json({diagnostic:{phase:'native_initialization',code:'ENOSPC',message:'credential-fixture-secret'}},{status:500});}};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const body={requestId:'dieter-failure-0',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}};
 const response=await runner.infer(body),result=await response.json();assert.equal(response.status,503);assert.deepEqual(result.diagnostic,{phase:'native_initialization',code:'ENOSPC'});assert.ok(!JSON.stringify(result).includes('credential-fixture-secret'));
 assert.equal((await runner.infer(body)).status,409);assert.equal(calls,1);
});
test('Dieter waits for placement and HTTP health before sending credentials to inference',async()=>{
 const {ctx}=setup(),order=[];
 const env={AUTH_KEY:Buffer.alloc(32,3).toString('base64'),async startAndWaitForPorts(options){order.push('placement');assert.equal(options.ports,8080);assert.equal(options.cancellationOptions.instanceGetTimeoutMS,120000);},async containerFetch(request){
  if(typeof request==='string'){order.push('health');return new Response('ok');}
  order.push('inference');assert.ok((await request.json()).auth.tokens.refresh_token);return Response.json({text:'ready',receipt:{transport:'codex-native'}});
 }};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const result=await(await runner.infer({requestId:'dieter-preflight-ready',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'preflight'}})).json();
 assert.deepEqual(order,['placement','health','inference']);assert.equal(result.receipt.container_health_verified,true);
});
test('failed container placement never sends an inference, and returns only safe diagnostics',async()=>{
 const {ctx}=setup();let calls=0;
 const env={AUTH_KEY:Buffer.alloc(32,4).toString('base64'),async startAndWaitForPorts(){throw Error('There is no container instance fixture-secret');},async containerFetch(){calls++;}};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const response=await runner.infer({requestId:'dieter-preflight-unavailable',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'preflight'}}),result=await response.json();
 assert.equal(response.status,503);assert.equal(calls,0);assert.deepEqual(result.diagnostic,{phase:'container_startup',code:'placement_unavailable'});assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
test('tool traces are archived privately and removed from public cached results',async()=>{
 const {ctx,map}=setup(),artifacts=[];
 const env={AUTH_KEY:Buffer.alloc(32,8).toString('base64'),AUDIT:{async put(k,v){artifacts.push({k,v});}},containerFetch:async()=>Response.json({text:'done',privateEvents:'private upload receipts',auth:{auth_mode:'chatgpt',tokens:{refresh_token:'refreshed'}}})};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const result=await(await runner.infer({requestId:'dieter-claim-0',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}})).json();
 assert.equal(result.privateEvents,undefined);assert.equal(result.auth,undefined);assert.equal(artifacts.length,1);
 assert.ok(!JSON.stringify([...map]).includes('private upload receipts'));
});

for(const mode of ['work','reconcile'])test('Dieter '+mode+' checks current placement and health before durable intent',async()=>{
 const {ctx,map}=setup(),order=[];
 const env={AUTH_KEY:Buffer.alloc(32,5).toString('base64'),async startAndWaitForPorts(options){order.push('placement');assert.equal(options.cancellationOptions.instanceGetTimeoutMS,120000);},async containerFetch(request){
  if(typeof request==='string'){order.push('health');assert.equal([...map.keys()].some(k=>k.startsWith('dieter-intent:')),false);return new Response('ok');}
  order.push('inference');assert.equal([...map.keys()].some(k=>k.startsWith('dieter-intent:')),true);return Response.json({text:'done'});
 }};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 assert.equal((await runner.infer({requestId:'placement-'+mode,operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode}})).status,200);
 assert.deepEqual(order,['placement','health','inference']);
});
test('failed work health never sends inference or records a publication intent',async()=>{
 const {ctx,map}=setup();let inference=0;
 const env={AUTH_KEY:Buffer.alloc(32,2).toString('base64'),async startAndWaitForPorts(){},async containerFetch(request){if(typeof request==='string')return new Response('not ready',{status:503});inference++;}};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const response=await runner.infer({requestId:'failed-work-health',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}});
 assert.equal(response.status,503);assert.equal(inference,0);assert.equal([...map.keys()].some(k=>k.startsWith('dieter-intent:')),false);
});
test('SDK text failures become closed diagnostics without exposing raw bodies or retrying work',async()=>{
 const {ctx}=setup();let calls=0;
 const env={AUTH_KEY:Buffer.alloc(32,1).toString('base64'),async containerFetch(){calls++;return new Response('There is no container instance fixture-secret',{status:500});}};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const body={requestId:'proxy-failure',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}};
 const response=await runner.infer(body),result=await response.json();assert.deepEqual(result.diagnostic,{phase:'container_startup',code:'placement_unavailable'});assert.ok(!JSON.stringify(result).includes('fixture-secret'));
 assert.equal((await runner.infer(body)).status,409);assert.equal(calls,1);
});

test('runtime diagnostic is admin-only and accepts no caller-selected payload',async()=>{
 let calls=0;const env={ADMIN_KEY:'fixture-admin',RUNNER:{getByName(){return {runtimeCheck:async()=>{calls++;return Response.json({fixed:true});}};}}};
 assert.equal((await handler.fetch(new Request('https://example/runtime-check'),env)).status,404);assert.equal(calls,0);
 const headers={Authorization:'Bearer fixture-admin'};
 assert.equal((await handler.fetch(new Request('https://example/runtime-check',{method:'POST',headers,body:'arbitrary'}),env)).status,404);assert.equal(calls,0);
 assert.equal((await handler.fetch(new Request('https://example/runtime-check?cmd=ignored',{headers}),env)).status,200);assert.equal(calls,1);
});
test('runtime diagnostic checks real container health after fixed helper results without stored login or intent',async()=>{
 const {ctx,map}=setup(),paths=[];
 const env={async startAndWaitForPorts(){},async containerFetch(path,init){paths.push(path);assert.equal(init.method,'GET');return path.endsWith('/health')?new Response('ok'):Response.json({version:'stdin-safety-v1',tools_ready:true,dieter_stdin_safe:true,diana_stdin_safe:true,process_alive:true,model_invocations:0,raw_secret:'must-not-return'});}};
 const response=await new CodexRunner(ctx,env).runtimeCheck();assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(paths,['http://container/runtime-check','http://container/health']);assert.equal(result.container_health_after,true);assert.equal(result.raw_secret,undefined);assert.equal(map.size,0);
});
test('failed runtime diagnostic remains closed and cannot accept a malformed pass',async()=>{
 const {ctx}=setup();const response=await new CodexRunner(ctx,{async startAndWaitForPorts(){},async containerFetch(){return Response.json({version:'stdin-safety-v1',tools_ready:true,dieter_stdin_safe:false,raw:'secret'});}}).runtimeCheck();
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'runtime_check_failed'});
});

for(const operation of ['context','image','reply','video_frames'])test('Direct '+operation+' verifies placement and health before inference',async()=>{
 const {ctx}=setup(),order=[];
 const env={AUTH_KEY:Buffer.alloc(32,3).toString('base64'),async startAndWaitForPorts(options){order.push('placement');assert.equal(options.cancellationOptions.portReadyTimeoutMS,120000);},async containerFetch(request){
  if(typeof request==='string'){order.push('health');return new Response('ok');}
  order.push('inference');return Response.json({text:'ready',receipt:{transport:'codex-native'}});
 }};
 const runner=new CodexRunner(ctx,env);await runner.seed({auth_mode:'chatgpt',tokens:{refresh_token:'fixture'}});
 const result=await(await runner.infer({requestId:'direct-ready-'+operation,operation,model:'gpt-6-luna'})).json();
 assert.deepEqual(order,['placement','health','inference']);assert.equal(result.receipt.container_health_verified,true);
});
for(const operation of ['context','image','reply','video_frames'])test('Direct '+operation+' stops before model on unavailable placement',async()=>{
 const {ctx,map}=setup();let calls=0;
 const runner=new CodexRunner(ctx,{async startAndWaitForPorts(){throw Error('There is no container instance');},async containerFetch(){calls++;}});
 const response=await runner.infer({requestId:'direct-unavailable-'+operation,operation,model:'gpt-6-luna'});
 assert.equal(response.status,503);assert.equal(calls,0);assert.equal(map.size,0);
 assert.deepEqual((await response.json()).diagnostic,{phase:'container_startup',code:'placement_unavailable'});
});
test('Direct entrypoint preserves singleton identity and rejects Dieter execution',async()=>{
 const names=[],requests=[];const env={RUNNER:{getByName(name){names.push(name);return {async infer(body){requests.push(body);return new Response('ok');}};}}};
 for(const Entry of [DirectInferenceService,InferenceService]){
  const service=new Entry();service.env=env;
  const request=body=>new Request('https://direct.internal/infer',{method:'POST',body:JSON.stringify(body)});
  assert.equal((await service.fetch(request({operation:'dieter_round'}))).status,400);
  assert.equal((await service.fetch(request({operation:'context'}))).status,200);
 }
 assert.deepEqual(names,['subscription-singleton','subscription-singleton']);assert.equal(requests.length,2);
 const dieter=new DieterExecutionService();dieter.env=env;
 assert.equal((await dieter.fetch(new Request('https://dieter.internal/infer',{method:'POST',body:JSON.stringify({operation:'context'})}))).status,400);
});
