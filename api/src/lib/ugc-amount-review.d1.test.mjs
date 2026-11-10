// Real isolated workerd D1 binding, real migrations and mounted auth/routes.
// No application config, credentials, remote DB, provider traffic or messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {build}=require('esbuild'),{Miniflare}=require('miniflare');
const NOW=Date.parse('2026-11-09T12:00:00Z');
const RID='00000000-0000-4000-8000-000000000001';
const workerSource=`
import route from '../routes/ugc.ts';
import {readAmountReview,saveAmountReview} from './ugc-amount-review.mjs';
import {payoutStore} from './ugc-payout-store.ts';
export default {async fetch(request,env){
 const body=await request.json(),batches=[],provider=[];
 const stmt=({sql,params=[]})=>params.length?env.DB.prepare(sql).bind(...params):env.DB.prepare(sql);
 if(body.action==='batch')return Response.json({results:await env.DB.batch(body.statements.map(stmt))});
 const DB={prepare(sql){return env.DB.prepare(sql)},async batch(statements){
  if(body.beforeBatch){await env.DB.batch(body.beforeBatch.map(stmt));body.beforeBatch=null;}
  const results=await env.DB.batch(statements);batches.push(results);
  if(body.afterCommit==='lost')throw Error('synthetic lost acknowledgement');
  if(body.corrupt==='partial')return results.slice(0,3);
  return results;
 }};
 const syntheticKonsol={
  async bankMember(){provider.push('bank');return {found:true,name:'Synthetic bank'}},
  async companyAccounts(){provider.push('accounts');return {ok:true,body:{collection:[{balance:'1936615.38'}]}}},
  async findContractorByPhone(){provider.push('contractor');return {id:'synthetic'}},
  async createPayment(){provider.push('payment');throw Error('Unexpected provider POST')},
 };
 let result;
 if(body.action==='read')result=await readAmountReview(DB,'p',body.requestId??null);
 else if(body.action==='save')result=await saveAmountReview(DB,body.input);
 else if(body.action==='claim'){
  const store=payoutStore({DB}),row=await store.getPayout('p'),requisites=await store.getRequisites('p');
  result=row&&requisites?await store.claim('p','synthetic-claim','2026-11-09T12:00:00Z',{row,requisites}):false;
 }
 else if(body.action==='route'){
  const response=await route.request('https://synthetic.test'+body.path,{method:body.method,
   headers:{'content-type':'application/json',...(body.user?{Authorization:'Bearer '+body.user+'-test-session-token'}:{})},
   ...(body.body===undefined?{}:{body:JSON.stringify(body.body)})},{DB,syntheticKonsol});
  result={http:response.status,...await response.json()};
 }else return new Response('Unknown action',{status:400});
 return Response.json({result,batches,provider});
}};
`;
async function bounded(promise,label,ms=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),ms)})])}finally{clearTimeout(timer)}}

test('isolated Worker D1: save-only amount review and hold boundary',{timeout:120000},async t=>{
 const bundle=await build({stdin:{contents:workerSource,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,
 plugins:[{name:'synthetic-provider',setup(b){
  b.onResolve({filter:/\/konsol$/},a=>({path:a.path,namespace:'provider'}));
  b.onLoad({filter:/.*/,namespace:'provider'},()=>({contents:'export const konsolClient = env => env.syntheticKonsol;'}));
  b.onResolve({filter:/\/konsol-balance$/},a=>({path:a.path,namespace:'balance'}));
  b.onLoad({filter:/.*/,namespace:'balance'},()=>({contents:'export const warnIfShort = async () => null; export const konsolOwnRub = async () => 0;'}));
 }}]});
 const outbound=[];
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2024-12-01',host:'127.0.0.1',port:0,
 d1Databases:{DB:'synthetic-amount-review-only'},d1Persist:false,cachePersist:false,outboundService(req){outbound.push(req.url);throw Error('External network forbidden')}});
 t.after(async()=>{try{await bounded(mf.dispose(),'cleanup',5000)}finally{assert.deepEqual(outbound,[])}});
 await bounded(mf.ready,'startup');
 async function call(body){const r=await bounded(mf.dispatchFetch('http://localhost/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),'worker request');assert.equal(r.status,200,await r.clone().text());return r.json()}
 const batch=async statements=>(await call({action:'batch',statements})).results;
 const query=async(sql,...params)=>(await batch([{sql,params}]))[0].results;
 const route=async(method,path,body,user='owner')=>(await call({action:'route',method,path,body,user}));
 for(const name of ['0060_crm_website.sql','0098_ugc_creator_pipeline.sql','0116_ugc_payouts.sql','0119_ugc_payouts_konsol.sql','0120_ugc_ig_messages.sql','0128_ugc_payout_product.sql','0136_ugc_payout_notice_status.sql']){
  const sql=(await readFile(new URL('../../../db/migrations/'+name,import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
  assert.doesNotMatch(sql,/\b(?:TRIGGER|INSERT|UPDATE|DELETE)\b/i);
  for(const literal of sql.match(/'(?:[^']|'')*'/g)??[])assert.ok(!literal.includes(';'));
  await batch(sql.split(';').map(sql=>sql.trim()).filter(Boolean).map(sql=>({sql})));
 }
 await batch([{sql:'CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,permissions TEXT)'},{sql:'CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER)'},
 {sql:`INSERT INTO users VALUES('owner','Synthetic owner','admin',1,'{}'),('writer','Synthetic manager','manager',1,'{"/ugc":"rw"}')`},
 {sql:'INSERT INTO sessions VALUES(?1,?2,?3),(?4,?5,?3)',params:['owner-test-session-token','owner',Date.now()+3600000,'writer-test-session-token','writer']}]);
 async function reset(){await batch([
  {sql:'DROP TRIGGER IF EXISTS synthetic_mutation'},
  ...['ugc_payout_requisites','ugc_payouts','ugc_creators','crm_sync_state'].map(table=>({sql:'DELETE FROM '+table})),
  {sql:"INSERT INTO ugc_creators(id,normalized_handle,created_at,updated_at) VALUES('c','synthetic',0,0)"},
  {sql:"INSERT INTO ugc_payouts(id,creator_id,amount_minor,status,payout_date,created_at,updated_at,fps_bank_member_id,bank_ref) VALUES('p','c',1,'awaiting_approval','2026-11-09',0,0,'100000000004','Synthetic bank')"},
  {sql:"INSERT INTO ugc_payout_requisites(payout_id,fps_mobile_phone,first_name,created_at,updated_at) VALUES('p','+79000000011','Synthetic',0,0)"}
 ])}
 const read=async(requestId=null)=>(await call({action:'read',requestId})).result;
 const input=async(amount_minor=45300)=>({id:'p',creator_id:'c',expected_snapshot:(await read()).payout.review_snapshot,amount_minor,request_id:RID,actor_id:'owner',now:NOW});
 const save=(input,extra={})=>call({action:'save',input,...extra});
 const payout=async()=>(await query("SELECT * FROM ugc_payouts WHERE id='p'"))[0];
 const holds=()=>query("SELECT * FROM crm_sync_state WHERE key LIKE 'payout_hold:%'");
 const receipts=()=>query("SELECT * FROM crm_sync_state WHERE key LIKE 'ugc_amount_review:%'");
 const snapshot=async()=>JSON.stringify({p:await query('SELECT * FROM ugc_payouts'),r:await query('SELECT * FROM ugc_payout_requisites'),s:await query('SELECT * FROM crm_sync_state ORDER BY key')});

 await t.test('mounted admin route saves amount only; actual D1 metadata and receipt replay',async()=>{
  await reset();const body=await input(),before=await payout(),reqs=await query('SELECT * FROM ugc_payout_requisites');
  const {id,actor_id,now,...request}=body;
  for(const [user,http] of [[null,401],['writer',403]])assert.equal((await route('POST','/payouts/p/amount-review',request,user)).result.http,http);
  const out=await route('POST','/payouts/p/amount-review',request);assert.equal(out.result.http,200);assert.equal(out.result.result.payout_hold,true);
  assert.deepEqual(out.provider,[]);assert.equal(out.batches.length,1);assert.equal(out.batches[0].length,6);
  assert.ok(out.batches[0].every(row=>row.success===true));assert.equal(out.batches[0][0].meta.changes,1);assert.equal(out.batches[0][1].meta.changes,1);assert.equal(out.batches[0][2].meta.changes,1);
  assert.equal(out.batches[0][3].results[0].verified,'null');
  const after=await payout();assert.deepEqual(after,{...before,amount_minor:45300,updated_at:after.updated_at});assert.deepEqual(await query('SELECT * FROM ugc_payout_requisites'),reqs);
  const replay=await route('POST','/payouts/p/amount-review',request);assert.equal(replay.result.result.replay,true);assert.equal(replay.batches.length,0);
  assert.equal((await read(RID)).payout.saved_request.amount_minor,45300);
 });
 await t.test('saved hold blocks actual claim, old execute, generic PATCH, status and paid-outside',async()=>{
  await reset();await save(await input());assert.equal((await call({action:'claim'})).result,false);
  const execute=await route('POST','/payouts/p/execute',{});assert.equal(execute.result.http,409);assert.ok(!execute.provider.includes('payment'));assert.ok(!execute.provider.includes('contractor'));
  assert.equal((await route('PATCH','/payouts/p',{amount_rub:550})).result.http,409);
  assert.equal((await route('POST','/payouts/p/status',{status:'paid'})).result.http,409);
  assert.deepEqual((await route('POST','/payouts/paid-outside',{ids:['p']})).result.result.marked,[]);
  assert.equal((await payout()).status,'awaiting_approval');assert.equal((await holds()).length,1);
 });
 await t.test('preexisting claim and claim arriving after snapshot both reject save',async()=>{
  for(const timing of ['before','race']){await reset();const b=await input();
   if(timing==='before')assert.equal((await call({action:'claim'})).result,true);
   const r=await save(b,timing==='race'?{beforeBatch:[{sql:"UPDATE ugc_payouts SET execute_claim='racing' WHERE id='p'"}]}:{});
   assert.equal(r.result.http,409);assert.equal((await payout()).amount_minor,1);assert.equal((await holds()).length,0);assert.equal((await receipts()).length,0);
  }
 });
 await t.test('concurrent amount/name/source identity/provider mutations fail the real SQL CAS',async()=>{
  for(const sql of ["UPDATE ugc_payouts SET amount_minor=52000 WHERE id='p'","UPDATE ugc_payout_requisites SET first_name='Changed' WHERE payout_id='p'","UPDATE ugc_payouts SET product='different' WHERE id='p'","UPDATE ugc_payouts SET konsol_payment_id='existing' WHERE id='p'","UPDATE ugc_payouts SET konsol_contractor_id='existing' WHERE id='p'"]){
   await reset();const r=await save(await input(),{beforeBatch:[{sql}]});assert.equal(r.result.http,409);assert.equal((await holds()).length,0);assert.equal((await receipts()).length,0);
  }
 });
 await t.test('existing hold retained byte-for-byte and name/source absence never invents readiness',async()=>{
  await reset();await batch([{sql:"INSERT INTO crm_sync_state VALUES('payout_hold:p','original hold',5)"},{sql:'UPDATE ugc_payout_requisites SET first_name=NULL'}]);
  const r=await save(await input(39400));assert.equal(r.result.ok,true);assert.deepEqual(await holds(),[{key:'payout_hold:p',value:'original hold',updated_at:5}]);
  assert.equal((await query('SELECT first_name FROM ugc_payout_requisites'))[0].first_name,null);assert.equal((await payout()).product,null);assert.equal((await call({action:'claim'})).result,false);
 });
 await t.test('actual D1 invariant failure rolls back amount, receipt and new or preexisting hold together',async()=>{
  for(const mutation of ["DELETE FROM crm_sync_state WHERE key='payout_hold:p'","UPDATE ugc_payout_requisites SET first_name='unexpected' WHERE payout_id='p'","UPDATE ugc_payouts SET bank_ref='unexpected' WHERE id='p'"]){
   for(const held of [false,true]){await reset();if(held)await query("INSERT INTO crm_sync_state VALUES('payout_hold:p','original',7)");
    const b=await input(),before=await snapshot();
    await query(`CREATE TRIGGER synthetic_mutation AFTER UPDATE OF amount_minor ON ugc_payouts WHEN NEW.amount_minor=45300 BEGIN ${mutation}; END`);
    assert.equal((await save(b)).result.http,503);assert.equal(await snapshot(),before);
   }
  }
 });
 await t.test('partial and lost D1 acknowledgements never fake success; same receipt reconciles',async()=>{
  for(const extra of [{corrupt:'partial'},{afterCommit:'lost'}]){await reset();const b=await input();assert.equal((await save(b,extra)).result.http,503);
   assert.equal((await payout()).amount_minor,45300);assert.equal((await holds()).length,1);
   assert.equal((await read(RID)).payout.saved_request.request_id,RID);assert.equal((await save(b)).result.replay,true);
  }
 });
 await t.test('double submit commits exactly once; different intent cannot replay',async()=>{
  await reset();const b=await input(),results=await Promise.all(Array.from({length:8},()=>save(b)));
  assert.ok(results.every(r=>r.result.ok));assert.equal(results.filter(r=>!r.result.replay).length,1);assert.equal((await receipts()).length,1);
  assert.equal((await save({...b,amount_minor:39400})).result.http,409);
 });
 await t.test('malformed amounts and old one-kopeck PATCH/paid-outside clients never mutate',async()=>{
  await reset();const b=await input(),before=await snapshot();
  for(const amount_minor of [1,4999,100000,45300.1,'45300'])assert.equal((await save({...b,amount_minor})).result.http,422);
  assert.equal((await route('PATCH','/payouts/p',{amount_rub:453})).result.http,409);
  assert.deepEqual((await route('POST','/payouts/paid-outside',{ids:['p']})).result.result.marked,[]);assert.equal(await snapshot(),before);
 });
});
