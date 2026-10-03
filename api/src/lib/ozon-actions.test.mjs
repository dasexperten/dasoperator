import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {transformSync}=require('esbuild');
const code=transformSync(readFileSync(new URL('./ozon-actions.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'}).code;
const {moneyRub,normalizeActionProduct,readActionProducts,assertLegacyPromotionWriteSafe}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('Money decimals/zero survive; unknown stays unknown; invalid/cross-currency fails',()=>{
 assert.equal(moneyRub({amount:'4000.25',currency:'RUB'}),4000.25);
 assert.equal(moneyRub({amount:'0',currency:'RUB'}),0);
 assert.equal(moneyRub(undefined),undefined);
 for(const value of [{amount:'5',currency:'CNY'},{amount:'',currency:'RUB'},{amount:'NaN',currency:'RUB'},-1])assert.throws(()=>moneyRub(value));
});
test('seller floor is not overwritten by marketplace floor; membership is not derived from zero stock',()=>{
 const product=normalizeActionProduct({id:77,add_mode:'AUTO',stock:0,action_price:{amount:'700',currency:'RUB'},min_seller_price:{amount:'500',currency:'RUB'},min_price:900});
 assert.equal(product.min_price,900);assert.equal(product.min_seller_price,500);
 assert.equal(product.add_mode,'AUTO');assert.equal(product.stock,0);assert.equal(product.id,77);
 assert.deepEqual(product.action_price_money,{amount:'700',currency:'RUB'});
});
test('cursor follows short page and preserves candidates endpoint separately',async()=>{
 const calls=[]; const rows=await readActionProducts(async(path,body)=>{calls.push({path,body});return calls.length===1?{products:[{id:1,price:{amount:'100',currency:'RUB'}}],last_id:'next'}:{products:[{id:2}],last_id:''};},9,true);
 assert.deepEqual(rows.map(p=>p.id),[1,2]);assert.equal(calls[1].body.last_id,'next');assert.equal(calls[0].body.limit,100);assert.equal(calls[0].path,'/v2/actions/candidates');assert.equal('offset' in calls[0].body,false);
});
test('repeated cursor and malformed pages fail rather than publishing partial membership',async()=>{
 await assert.rejects(()=>readActionProducts(async()=>({products:[{id:1}],last_id:'same'}),9));
 await assert.rejects(()=>readActionProducts(async()=>({last_id:''}),9));
});
test('cutover blocks every legacy write before network; read-only and pre-cutover remain allowed',()=>{
 for(const path of ['/v1/actions/products/activate','/v1/actions/products/deactivate']){
  assert.doesNotThrow(()=>assertLegacyPromotionWriteSafe(path,Date.parse('2026-10-12T20:59:59Z')));
  assert.throws(()=>assertLegacyPromotionWriteSafe(path,Date.parse('2026-10-12T21:00:00Z')),/no price or membership was changed/);
 }
 assert.doesNotThrow(()=>assertLegacyPromotionWriteSafe('/v2/actions/products',Date.parse('2026-10-14')));
});

const route=readFileSync(new URL("../routes/marketplaces-promos.ts",import.meta.url),"utf8");
const requestCode=route.slice(route.indexOf("async function ozonRequest<T>"),route.indexOf("async function fetchAllProductInfo"));
const runtime=code+transformSync(requestCode+"\nexport {ozonRequest};",{loader:"ts",format:"esm"}).code;
const {ozonRequest}=await import("data:text/javascript;base64,"+Buffer.from(runtime).toString("base64"));
test("actual route adapter sends only v2 cursor reads and refuses post-cutover writes before fetch",async()=>{
 const originalFetch=globalThis.fetch, originalNow=Date.now;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({products:[{id:calls.length,action_price:{amount:"750.5",currency:"RUB"}}],last_id:calls.length===1?"second":""})};};
 try {
  const result=await ozonRequest({OZON_CLIENT_ID:"test",OZON_API_KEY:"test"},"/v1/actions/products","POST",{action_id:3,limit:1000,offset:0});
  assert.deepEqual(result.result.products.map(p=>p.id),[1,2]);assert.equal(result.result.products[0].action_price,750.5);assert.ok(calls.every(c=>c.url.endsWith("/v2/actions/products")));
  Date.now=()=>Date.parse("2026-10-14");
  await assert.rejects(()=>ozonRequest({},"/v1/actions/products/activate","POST",{products:[{action_price:500}]}));assert.equal(calls.length,2);
 } finally {globalThis.fetch=originalFetch;Date.now=originalNow;}
});

test("live empty-currency Money and echoed-cursor empty terminal are retained without invented RUB",async()=>{
 let n=0;const products=await readActionProducts(async()=>({products:++n===1?[{id:7,action_price:{amount:"797",currency:""}}]:[],total:1,last_id:"7"}),9);
 assert.equal(products[0].action_price,797);assert.equal(products[0].currency_is_explicit_rub,false);assert.equal(n,2);
 await assert.rejects(()=>readActionProducts(async()=>({products:[],total:1,last_id:"7"}),9));
});

test('string product IDs normalize safely without losing original representation',async()=>{
 const rows=await readActionProducts(async()=>({products:[{id:'77'}],last_id:''}),9);
 assert.equal(rows[0].id,77);assert.equal(rows[0].id_raw,'77');
 for(const id of ['not-an-id','9007199254740993'])await assert.rejects(readActionProducts(async()=>({products:[{id}],last_id:''}),9),/invalid/);
});
