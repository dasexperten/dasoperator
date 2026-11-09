import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'payout-source-'));
await createRequire(import.meta.url)('esbuild').build({entryPoints:[fileURLToPath(new URL('./ugc-payout-source.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'source.mjs'),plugins:[{name:'save-boundary',setup(b){b.onResolve({filter:/ugc-payout-intake$/},()=>({path:'save',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const prepareCreatorPayout=async(_e,facts)=>{globalThis.__intake.push(facts)}'}));}}]});
const {ingestCreatorPayouts}=await import(pathToFileURL(join(dir,'source.mjs')));rmSync(dir,{recursive:true});
function fixture(t,existing=null){
 const original={id:'details',created_time:new Date(Date.now()-60000).toISOString(),from:{id:'creator',username:'alice'},message:'89990000000 ТБанк Елена'};
 const reply={id:'ack',created_time:new Date().toISOString(),from:{id:'17841466350261166',username:'dasexperten'},message:'Данные получила'};
 const archived=[];globalThis.__intake=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.method,undefined);return Response.json(url.includes('conversations?')?{data:[{id:'chat',messages:{data:[reply,original]}}]}:{access_token:'test-page'})});
 const DB={prepare(sql){let p=[];return{bind(...v){p=v;return this},sql,get params(){return p},async all(){return{results:archived}},async first(){if(sql.includes('FROM ugc_payouts'))return existing;return null}}},async batch(qs){for(const q of qs){const p=q.params;archived.push({id:p[0],direction:p[2],from_username:p[4],text:p[5],created_at:p[7]})}return[]}};
 return{DB,META_IG_MESSAGING_TOKEN:'test'};
}
test('live source is archived before intake even when our acknowledgement is newest',async t=>{
 assert.equal(await ingestCreatorPayouts(fixture(t)),1);assert.equal(globalThis.__intake.length,1);assert.equal(globalThis.__intake[0].handle,'alice');assert.equal(globalThis.__intake[0].first_name,'Елена');assert.deepEqual(globalThis.__intake[0].source_message_ids,['details']);
});
test('a recent paid creator never gets a new payout from repeated details',async t=>{
 assert.equal(await ingestCreatorPayouts(fixture(t,{id:'paid',status:'paid',konsol_payment_id:'sent'})),0);assert.equal(globalThis.__intake.length,0);
});
test('unavailable original source fails the payout intake visibly',async t=>{
 const env=fixture(t);t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message:'unavailable'}},{status:503}));await assert.rejects(ingestCreatorPayouts(env),/payment_source_unavailable/);assert.equal(globalThis.__intake.length,0);
});
