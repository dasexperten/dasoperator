import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../online-daily.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'stub-transports',setup(b){
 b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'worker',namespace:'stub'}));
 b.onResolve({filter:/\/gmail-client$/},()=>({path:'gmail',namespace:'stub'}));
 b.onResolve({filter:/\/google-workspace$/},()=>({path:'google',namespace:'stub'}));
 b.onResolve({filter:/\/mail-archive-recovery$/},()=>({path:'archive',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({contents:{worker:'export class WorkerEntrypoint{}',archive:'export const mailArchiveEnv=e=>e;',google:'export const workspaceAccounts=()=>[{email:"sales@dasexperten.com"}];export const gmailRequest=async()=>({messages:[{id:"message"}]});',gmail:'export const gmailSession=async()=>({token:"test"});export const gmailMessage=async()=>({});export const gmailSummary=()=>({from:"seller@a-plus.ru",to:"dasexperten@gmail.com",subject:"Изменения в Договор",timestamp:"2026-11-13T06:17:00Z"});export const gmailBody=async()=>({text:"Новая редакция действует с 16.11.2026",attachments:[]});'}[path]}));
 }}]});
const {onlineDaily}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch=async()=>new Response('',{status:403});
function fixture(){const rows=new Map();let sends=0;let failWb=false;const db={prepare(sql){return{bind(...a){return{async first(){if(a[0]==='online-daily:wb-source'){if(failWb){failWb=false;throw Error('DB temporary');}return null;}return rows.has(a[0])?{value:rows.get(a[0])}:null;},async all(){return{results:[]};},async run(){
 if(sql.startsWith('INSERT')){if(rows.has(a[0]))return{meta:{changes:0}};rows.set(a[0],a[1]);return{meta:{changes:1}};}
 const [value,,key,match]=a,old=rows.has(key)?JSON.parse(rows.get(key)):null;
 if(sql.includes('AND value=?')&&rows.get(key)!==match)return{meta:{changes:0}};
 if(sql.includes("$.claim")&&old?.claim!==match)return{meta:{changes:0}};
 if(sql.includes("state')='collecting'")&&old?.state!=='collecting')return{meta:{changes:0}};
 rows.set(key,value);return{meta:{changes:1}};
 }}}}}};const env={DB:db,ARCHIVE:{},DASORG_API_KEY:'test',ORGANIZATION:{async fetch(_url,init){sends++;assert.equal(JSON.parse(init.body).daily_report,true);return Response.json({ok:true,message_id:123});}}};return{env,rows,get sends(){return sends},failOnce(){failWb=true;}};}
const at=Date.parse('2026-11-13T09:00:00Z');
test('preview reads real transport contracts but writes and sends nothing',async()=>{const f=fixture();const r=await onlineDaily(f.env,{at,preview:true});assert.match(r.text,/16.11.2026/);assert.equal(f.rows.size,0);assert.equal(f.sends,0);assert.equal(r.evidence.newsModel,null);});
test('delivered partial report has one durable receipt and repeat never sends again',async()=>{const f=fixture();const first=await onlineDaily(f.env,{at});assert.equal(first.state,'sent');assert.equal(first.complete,false);assert.equal(f.sends,1);const second=await onlineDaily(f.env,{at});assert.equal(second.duplicate,true);assert.equal(second.message_id,123);assert.equal(f.sends,1);});
test('ambiguous Telegram receipt remains sending and repeat does not duplicate',async()=>{const f=fixture();f.env.ORGANIZATION.fetch=async()=>{throw Error('lost response');};await assert.rejects(onlineDaily(f.env,{at}),/delivery_requires_reconciliation/);assert.equal(JSON.parse(f.rows.get('online-daily:2026-11-13')).state,'sending');const r=await onlineDaily(f.env,{at});assert.equal(r.state,'sending');assert.equal(r.duplicate,true);});
test('failure before send is retryable and successful retry changes unique claim',async()=>{const f=fixture();f.failOnce();await assert.rejects(onlineDaily(f.env,{at}),/DB temporary/);assert.equal(JSON.parse(f.rows.get('online-daily:2026-11-13')).state,'failed');assert.equal(f.sends,0);const r=await onlineDaily(f.env,{at});assert.equal(r.state,'sent');assert.equal(f.sends,1);});
