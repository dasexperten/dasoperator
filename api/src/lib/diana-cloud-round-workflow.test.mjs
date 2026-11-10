import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('../diana-cloud-round-workflow.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'fixtures',setup(b){
 b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'worker',namespace:'stub'}));
 b.onResolve({filter:/^\.\/lib\/diana-cloud$/},()=>({path:'cloud',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},({path})=>({contents:path==='worker'?`export class WorkflowEntrypoint {constructor(env){this.env=env}}`:`export const readCloudConversation=async()=>({status:'ready',key:'s'});export const prepareCloudDecision=async()=>({status:'ready',key:'c'});export const draftCloudDecision=async()=>({key:'d'});export const deliverCloudDecision=async()=>({status:'no_reply',reason:'observed'});export const completeCloudEvent=async()=>({status:'complete',outcome:'no_reply'});export const stateWrite=async(env,key,value)=>env.DB.prepare('INSERT INTO crm_sync_state VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(value),Date.now()).run();`}));
}}]});
const {DianaCloudRoundWorkflow}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('round records each creator separately and keeps unsupported duties open',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_creators(id TEXT,normalized_handle TEXT,lifecycle_stage TEXT,archived_at INTEGER);CREATE TABLE ugc_content(creator_id TEXT,content_url TEXT);CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT,from_username TEXT,created_at TEXT);
 INSERT INTO ugc_creators VALUES('a','alice','paid',NULL),('b','bob','creation',NULL);INSERT INTO ugc_ig_messages VALUES('m1','chat','in','alice','2026-01-01');`);
 const run='diana-round-2026-11-10-morning';db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('diana_cloud_execution_lock',JSON.stringify({kind:'round',id:run}),Date.now());
 db.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run('manual_stage:a',JSON.stringify({to:'paid',at:1,reviewed_at:null}),1);
 const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this},async all(){return{results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}}},async batch(q){const out=[];for(const item of q)out.push(await item.run());return out}};
 const env={DB,DIANA_WAKE:{idFromName(){return 1},get(){return{async fetch(){return new Response('{}')}}}}};
 const step={async do(_name,_options,fn){return fn()}};const workflow=new DianaCloudRoundWorkflow(env);
 const outcome=await workflow.run({payload:{id:run,scheduled_at:1},instanceId:run},step);
 assert.equal(outcome.status,'partial');assert.equal(outcome.exceptions,2);
 const receipt=id=>JSON.parse(db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_round_receipt:'+run+':'+id).value);
 assert.equal(receipt('a').reason,'publication_not_verified');assert.equal(receipt('a').coauthor.reason,'collab_token_unavailable');assert.equal(receipt('a').conversation.status,'reviewed');assert.equal(receipt('a').manual_stage,'not_reviewed');
 assert.equal(receipt('b').reason,'original_conversation_identity_unavailable');assert.equal(db.prepare('SELECT 1 FROM crm_sync_state WHERE key=?').get('diana_cloud_execution_lock'),undefined);
});
