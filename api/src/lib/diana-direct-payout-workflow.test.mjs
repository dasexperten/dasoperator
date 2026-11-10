import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'direct-workflow-payout-'));
const stubs={
 'cloudflare:workers':`export class WorkflowEntrypoint{constructor(ctx,env){this.env=env}}`,
 'diana-alarm':`export const acknowledgeDianaEvent=()=>{throw Error('payout must not ACK reply')}`,
 'diana-cloud-lock':`export const finishDianaCloud=async env=>{env.released++}`,
 'ig-dm-image-cache':`export const loadInstagramImage=async()=>{throw Error('unexpected image')}`,
 'diana-direct-original.mjs':`export const readDirectOriginal=async({conversationId,messageId})=>({status:'ready',conversationId,messageId,messages:[{id:messageId,from:{id:'person',username:'creator'},message:'PRIVATE SOURCE'}]})`,
 'diana-direct-think.mjs':`export const directThink=()=>()=>{throw Error('unexpected inference')}`,
 'diana-direct-decide.mjs':`export const decideDirect=async()=>({action:'payout',reason:'payout_handoff_pending'})`,
 'diana-direct-deliver.mjs':`export const deliverDirectReply=()=>{throw Error('payout must not send')}`,
 'diana-context.mjs':`export const prepareDianaContext=()=>{throw Error('fixture decide owns context')}`,
 'diana-direct-payout.mjs':`export const handoffDirectPayout=async({env,event,source,refreshOriginal,infer,readImage})=>{if(source.messageId!==event.message_id||typeof refreshOriginal!=='function'||typeof infer!=='function'||typeof readImage!=='function')throw Error('bad wiring');env.handoffs.push(event.event_id);return{status:'registered',payout_id:'p-'+event.message_id,amount_minor:48900}}`
};
await build({entryPoints:[fileURLToPath(new URL('../diana-direct-workflow.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'workflow.mjs'),plugins:[{name:'boundaries',setup(b){b.onResolve({filter:/.*/},a=>{const n=a.path==='cloudflare:workers'?a.path:a.path.split('/').at(-1);return stubs[n]?{path:n,namespace:'test'}:undefined});b.onLoad({filter:/.*/,namespace:'test'},a=>({contents:stubs[a.path]}))}}]});
const {DianaDirectWorkflow}=await import(pathToFileURL(join(dir,'workflow.mjs')));rmSync(dir,{recursive:true});
function fixture() {
 const env={handoffs:[],saved:[],released:0,wakes:0,META_IG_MESSAGING_TOKEN:'test'};
 env.DB={prepare(sql){
  let p=[];
  return {
   bind(...v){p=v;return this;},
   async first(){return null;},
   async run(){if(sql.startsWith('INSERT'))env.saved.push(JSON.parse(p[1]));return {meta:{changes:1}};}
  };
 }};
 env.DIANA_WAKE={idFromName:()=>1,get:()=>({fetch:async()=>{env.wakes++;}})};
 return {env,workflow:new DianaDirectWorkflow({},env),step:{do:async(_n,_o,fn)=>fn()}};
}
const signals=[{cid:'chat-a',message_id:'a',event_id:'message:a'},{cid:'chat-b',message_id:'b',event_id:'message:b'}];
test('current batch workflow hands each payout off once, preserves batch and stores only preparation metadata',async()=>{const f=fixture();const out=await f.workflow.run({payload:{events:signals},instanceId:'batch'},f.step);assert.equal(out.status,'batch_processed');assert.equal(out.results.length,2);assert.deepEqual(f.env.handoffs.sort(),['message:a','message:b']);assert.ok(out.results.every(r=>r.status==='prepared'));assert.equal(f.env.saved.length,2);assert.doesNotMatch(JSON.stringify({out,saved:f.env.saved}),/PRIVATE SOURCE/);assert.equal(f.env.released,1);assert.equal(f.env.wakes,1)});
test('preview batch cannot create payouts; mixed preview rejected',async()=>{const f=fixture();await f.workflow.run({payload:{events:signals.map(x=>({...x,dryRun:true}))},instanceId:'batch'},f.step);assert.equal(f.env.handoffs.length,0);assert.equal(f.env.saved.length,0);assert.equal(f.env.released,0);await assert.rejects(f.workflow.run({payload:{events:[{...signals[0],dryRun:true},signals[1]]},instanceId:'mixed'},f.step),/mixed_preview/)});
