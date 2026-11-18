import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const calls=[];globalThis.__round={calls};
const result=await build({entryPoints:[fileURLToPath(new URL('../diana-cloud-round-workflow.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'stubs',setup(b){
 for(const [re,p] of [[/^cloudflare:workers$/,'worker'],[/diana-cloud-round-cohort$/,'cohort'],[/diana-round-collab$/,'collab'],[/diana-round-publications$/,'pub'],[/diana-round-run\.mjs$/,'run'],[/diana-direct-think\.mjs$/,'think'],[/diana-context\.mjs$/,'ctx'],[/ugc-direct-content$/,'direct'],[/ugc-content-confirm$/,'confirm'],[/diana-direct-video-watch\.mjs$/,'watch']])b.onResolve({filter:re},()=>({path:p,namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({contents:{
  worker:'export class WorkflowEntrypoint{constructor(env){this.env=env}}',
  cohort:"export const roundCandidates=async()=>[{id:'a',normalized_handle:'alice',lifecycle_stage:'paid'},{id:'b',normalized_handle:'bob',lifecycle_stage:'creation'}];",
  collab:"export const reviewRoundCollab=async(e,id)=>{globalThis.__round.calls.push('collab:'+id);return{status:'verified'}};",
  pub:"export const reviewRoundPublications=async(e,id)=>{globalThis.__round.calls.push('pub:'+id);if(id==='b')throw Error('x');return{status:'verified'}};",
  run:"export const runRoundCreator=async({person})=>{globalThis.__round.calls.push('run:'+person.id);if(person.id==='b')throw Error('boom');return{status:'sent',outgoing_id:'o'}};export const roundConversationId=async(e,person)=>person.id==='a'?'chat-a':null;",
  watch:'export const watchVideo=async()=>null;',
  direct:"export const recordCollabMedia=async()=>({recorded:1});export const scanDirectContent=async(e,h,cid)=>{globalThis.__round.calls.push('direct:'+h+':'+cid);return{links:1,videos:1}};",
  confirm:"let n=0;export const confirmPendingContent=async(e,o)=>{n++;globalThis.__round.calls.push('check:'+(o.exclude??[]).join('+'));return n===1?{selected:2,confirmed:1,not_ours:1,not_hers:0,unread:0,waiting:0,budget_exhausted:false,pending_ids:[],ids:['r1','r2']}:{selected:0,confirmed:0,not_ours:0,not_hers:0,unread:0,waiting:0,budget_exhausted:false,pending_ids:[],ids:[]}};",
  think:'export const directThink=()=>async()=>({text:"{}"});',ctx:'export const prepareDianaContext=async()=>({system:""});'}[path]}));
}}]});
const {DianaCloudRoundWorkflow}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('round handles each blogger on its own: one failure never stops the rest, and the summary is saved',async()=>{
 const saved=[];const env={DB:{prepare(){return{bind(...v){saved.push(v);return this},async run(){return{meta:{changes:1}}}}}}};
 const step={async do(_n,_o,fn){return fn()}};
 const out=await new DianaCloudRoundWorkflow(env).run({payload:{id:'diana-round-2026-11-10-morning',scheduled_at:1}},step);
 assert.equal(out.cohort,2);
 assert.equal(out.totals['sent'],1);assert.equal(out.totals['pending:round_execution_failed'],1);
 assert.equal(out.totals['publication:verified'],1);assert.equal(out.totals['publication:failed'],1);assert.equal(out.totals['collab:verified'],2);
 // Owner 2026-11-18: her Direct content is read for every blogger with a known chat, then the waiting reels are checked.
 assert.deepEqual(calls,['run:a','pub:a','collab:a','direct:alice:chat-a','run:b','pub:b','collab:b','check:','check:r1+r2']);
 const summary=JSON.parse(saved.find(v=>v[0]==='diana_round_run:diana-round-2026-11-10-morning')[1]);
 assert.deepEqual([summary.collab_media_recorded,summary.direct_links,summary.direct_videos,summary.content_check.confirmed,summary.content_check.selected],[1,1,1,1,2]);
 assert.ok(saved.some(v=>v[0]==='diana_round_run:diana-round-2026-11-10-morning'&&JSON.parse(v[1]).status==='complete'));
});
