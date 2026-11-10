import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const b=await build({entryPoints:[fileURLToPath(new URL('../diana-cloud-workflow.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'worker',namespace:'stub'}));b.onResolve({filter:/^\.\/lib\/diana-cloud$/},()=>({path:'cloud',namespace:'stub'}));b.onResolve({filter:/^\.\/lib\/diana-cloud-lock$/},()=>({path:'lock',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({contents:path==='worker'?`export class WorkflowEntrypoint {constructor(env){this.env=env}}`:path==='lock'?`export const finishDianaCloud=async(env)=>{env.released=true}`:`export const cloudEventKey=e=>'event:'+e.event_id;export const stateWrite=async(env,k,v)=>{env.saved={k,v}};export const readCloudConversation=async(env)=>{env.read=true;if(!env.scenario)globalThis.__clock=Date.parse('2026-11-10T23:30:00+03:00');return {status:'ready',key:'s'}};export const prepareCloudDecision=async(env)=>{env.context=true;return {status:'ready',key:'c'}};export const draftCloudDecision=async(env)=>{if(env.scenario==='before-handoff')globalThis.__clock=Date.parse('2026-11-10T23:30:00+03:00');return {key:'d'}};export const handoffCloudPayout=async(env)=>{env.handoff=true;if(env.scenario==='before-payment')globalThis.__clock=Date.parse('2026-11-10T23:30:00+03:00');return {payout_id:'p',recipient:'r'}};export const executeCloudPayout=async(env)=>{env.paid=true};export const deliverCloudDecision=async()=>({});export const completeCloudEvent=async()=>({});`}));
}}]});const {DianaCloudWorkflow}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
test('a read crossing 23:30 defers before context and releases the lock',async t=>{
 globalThis.__clock=Date.parse('2026-11-10T23:29:59+03:00');t.mock.method(Date,'now',()=>globalThis.__clock);
 const env={DIANA_WAKE:{idFromName(){return 1},get(){return{async fetch(){return new Response('{}')}}}}};
 const step={async do(_name,_opts,fn){return fn()}};const w=new DianaCloudWorkflow(env);
 const out=await w.run({payload:{event_id:'e'},instanceId:'id'},step);
 assert.equal(out.status,'deferred');assert.equal(env.read,true);assert.equal(env.context,undefined);assert.equal(env.saved.v.status,'deferred');assert.equal(env.released,true);
});
test('cutoff before payout handoff or submission defers without a transfer',async t=>{
 t.mock.method(Date,'now',()=>globalThis.__clock);
 for(const scenario of ['before-handoff','before-payment']){
  globalThis.__clock=Date.parse('2026-11-10T23:29:59+03:00');
  const env={scenario,DIANA_WAKE:{idFromName(){return 1},get(){return{async fetch(){return new Response('{}')}}}}};
  const result=await new DianaCloudWorkflow(env).run({payload:{event_id:'e'},instanceId:'id'},{async do(_name,_opts,fn){return fn()}});
  assert.equal(result.status,'deferred');assert.equal(env.paid,undefined);assert.equal(env.released,true);
  assert.equal(!!env.handoff,scenario==='before-payment');
 }
});
