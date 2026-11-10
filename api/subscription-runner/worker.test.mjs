import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
let source=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
source=source.replace("import { Container } from '@cloudflare/containers';","class Container {constructor(ctx,env){this.ctx=ctx;this.env=env;} containerFetch(...args){return this.env.containerFetch(...args);} startAndWaitForPorts(...args){return this.env.startAndWaitForPorts(...args);}}").replace("import { WorkerEntrypoint } from 'cloudflare:workers';","class WorkerEntrypoint {}");
const {CodexRunner,default:handler}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
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
