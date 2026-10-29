import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
let source=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
source=source.replace("import { Container } from '@cloudflare/containers';","class Container {constructor(ctx,env){this.ctx=ctx;this.env=env;} containerFetch(...args){return this.env.containerFetch(...args);}}").replace("import { WorkerEntrypoint } from 'cloudflare:workers';","class WorkerEntrypoint {}");
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
