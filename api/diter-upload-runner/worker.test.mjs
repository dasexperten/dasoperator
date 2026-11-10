import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
let code=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
code=code.replace("import { Container } from '@cloudflare/containers';","class Container{constructor(ctx,env){this.ctx=ctx;this.env=env;}startAndWaitForPorts(...args){return this.env.start?.(...args);}containerFetch(...args){return this.env.fetch(...args);}}").replace("import { WorkerEntrypoint } from 'cloudflare:workers';","class WorkerEntrypoint{}");
const {DieterRunner,default:handler}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function setup(fetch){const map=new Map();const ctx={storage:{async get(k){return map.get(k)},async put(k,v){map.set(k,v)},async delete(k){map.delete(k)},async list({prefix}){return new Map([...map].filter(([k])=>k.startsWith(prefix)))}}};return {map,runner:new DieterRunner(ctx,{AUTH_KEY:Buffer.alloc(32,2).toString('base64'),fetch,AUDIT:{async put(){}}})};}
const fixtureAuth={auth_mode:'chatgpt',tokens:{refresh_token:'synthetic-only'}};
test('public admin is closed without the explicit key',async()=>assert.equal((await handler.fetch(new Request('https://example/auth',{headers:{Authorization:'Bearer undefined'}}),{})).status,404));
test('Dieter-only contract and purpose/model validation precede any native request',async()=>{
 let calls=0;const {runner}=setup(async()=>{calls++;});assert.deepEqual((await runner.contract()).operations,['dieter_round']);
 for(const [operation,model]of[['context','gpt-6.1-terra'],['reply','gpt-6.1-terra'],['image','gpt-6-luna'],['dieter_round','gpt-6-astra']])assert.equal((await runner.infer({requestId:'bad',operation,model})).status,400);
 assert.equal(calls,0);
});
test('seed is encrypted, one-time, never returned by contract or inference',async()=>{
 const {runner,map}=setup(async req=>typeof req==='string'?new Response('ok'):Response.json({text:'READY',auth:{...fixtureAuth,last_refresh:'refreshed'},receipt:{transport:'codex-native',auth:'subscription',mode:'preflight'}}));
 await runner.seed(fixtureAuth);await assert.rejects(runner.seed(fixtureAuth),/already_seeded/);assert.equal((await runner.contract()).managed_login_present,true);
 const result=await(await runner.infer({requestId:'preflight',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'preflight'}})).json();
 assert.equal(result.auth,undefined);assert.equal(result.receipt.container_health_verified,true);assert.ok(!JSON.stringify([...map]).includes('synthetic-only'));
});
test('ambiguous work records intent once and cannot repeat the native operation',async()=>{
 let calls=0;const {runner}=setup(async req=>{if(typeof req==='string')return req.includes('/result/')?new Response('',{status:404}):new Response('ok');calls++;throw Error('synthetic-private-error');});await runner.seed(fixtureAuth);
 const body={requestId:'claim-work',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}};
 const response=await runner.infer(body);assert.equal(response.status,503);assert.deepEqual((await response.json()).diagnostic,{phase:'container_proxy',code:'http_unavailable'});
 assert.equal((await runner.infer(body)).status,409);assert.equal(calls,1);
});
test('fixed runtime check uses GET only, stores no intent and invokes no model',async()=>{
 const urls=[];const {runner,map}=setup(async url=>{urls.push(url);return url.endsWith('/health')?new Response('ok'):Response.json({version:'dieter-only-stdin-v1',tools_ready:true,dieter_stdin_safe:true,process_alive:true,model_invocations:0});});
 const result=await(await runner.runtimeCheck()).json();assert.equal(result.container_health_after,true);assert.equal(result.model_invocations,0);assert.equal(map.size,0);assert.deepEqual(urls,['http://container/runtime-check','http://container/health']);
});

test('disconnect reads exact cached result without replay and durable GET budget is three',async()=>{let posts=0,reads=0;const {runner,map}=setup(async req=>{if(typeof req==='string'){if(req.includes('/result/')){reads++;return Response.json({text:'saved',auth:fixtureAuth,receipt:{mode:'work'}});}return new Response('ok');}posts++;throw Error('disconnect');});await runner.seed(fixtureAuth);const body={requestId:'recover',operation:'dieter_round',model:'gpt-6.1-terra',execution:{mode:'work'}};const result=await(await runner.infer(body)).json();assert.equal(result.text,'saved');assert.equal(result.auth,undefined);assert.equal((await(await runner.infer(body)).json()).text,'saved');assert.equal(posts,1);assert.equal(reads,1);map.delete('result:recover');await runner.cachedContainerResult('recover');await runner.cachedContainerResult('recover');assert.equal(await runner.cachedContainerResult('recover'),null);assert.equal(reads,3);});
