import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require(require.resolve('esbuild',{paths:[process.cwd(),process.cwd()+'/workers']}));
const source=readFileSync(new URL('./crm-website.ts',import.meta.url),'utf8');
const start=source.indexOf('export async function pollStripeOrders('),end=source.indexOf('\n// -----------------------------------------------------------------------------',start);
const adapters=`const CURSOR_KEY='stripe:last_created', OVERLAP_SECONDS=3*86400, now=()=>10000000;
const stripeGet=(...a)=>globalThis.__stripePoll.stripeGet(...a),ingestPaymentIntent=(...a)=>globalThis.__stripePoll.ingest(...a);
const metaInt=n=>Number(n),recomputeCustomerAggregates=async()=>{};`;
const code=transformSync(adapters+source.slice(start,end),{loader:'ts',format:'esm'}).code;
const {pollStripeOrders}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function fixture(t){let cursorWrites=0,ingested=0;
 t.mock.method(console,'error',()=>{});
 const deps={stripeGet:async(_env,path)=>({data:path==='/payment_intents'?[{id:'one'},{id:'two'}]:[],has_more:false}),ingest:async()=>{ingested++;return {action:'updated'}}};globalThis.__stripePoll=deps;
 const env={STRIPE_SECRET_KEY:'fixture',DB:{prepare(sql){return {bind(){return this},async first(){return null},async run(){if(sql.includes('crm_sync_state'))cursorWrites++;return {success:true}}}}}};
 return {deps,env,counts:()=>({cursorWrites,ingested})};
}
test('one failed order preserves cursor while remaining idempotent ingestions finish',async t=>{
 const f=fixture(t);let calls=0;f.deps.ingest=async()=>{if(++calls===1)throw Error('DB unavailable');return {action:'updated'}};
 await assert.rejects(pollStripeOrders(f.env,{sinceEpoch:1}),/cursor preserved/);assert.equal(calls,2);assert.equal(f.counts().cursorWrites,0);
});
test('failed refund read preserves cursor',async t=>{
 const f=fixture(t),read=f.deps.stripeGet;f.deps.stripeGet=async(e,path)=>{if(path==='/refunds')throw Error('HTTP503');return read(e,path)};
 await assert.rejects(pollStripeOrders(f.env,{sinceEpoch:1}),/cursor preserved/);assert.equal(f.counts().cursorWrites,0);assert.equal(f.counts().ingested,2);
});
test('fully successful reconciliation advances cursor exactly once',async t=>{
 const f=fixture(t),r=await pollStripeOrders(f.env,{sinceEpoch:1});assert.equal(r.updated,2);assert.equal(f.counts().cursorWrites,1);
});
