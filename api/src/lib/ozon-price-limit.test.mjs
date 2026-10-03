import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildSync}=require('esbuild');
// Exercise actual Hono handlers, including floor reads, request payload,
// interpretation of the real flat v2 acknowledgement, and cache invalidation.
const bundle=buildSync({entryPoints:[new URL('../routes/marketplaces-promos.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false,nodePaths:[...require.resolve.paths('hono')]}).outputFiles[0].text;
const {default:app}=await import('data:text/javascript;base64,'+Buffer.from(bundle).toString('base64'));
function setup({minimum=100,update={active_product_ids:[77],deactivated_product_ids:[],rejected:[],warnings:[]},voucher=false,cacheFails=false,role='admin',access='rw'}={}) {
 const calls=[],deleted=[];
 const env={OZON_CLIENT_ID:'test',OZON_API_KEY:'test',DB:{prepare(){return{bind(){return this;},async first(){return{active:1,expires_at:Date.now()+3600000,id:'test-user',name:'Test',role,permissions:JSON.stringify({'/marketplaces':access})};}}}},CACHE:{async delete(key){deleted.push(key);if(cacheFails)throw new Error('cache');},async get(){return null;},async put(){}}};
 const originalFetch=globalThis.fetch,originalNow=Date.now;
 Date.now=()=>Date.parse('2026-10-14T12:00:00Z');
 globalThis.fetch=async(url,init)=>{
  calls.push({url,body:init.body?JSON.parse(init.body):undefined});
  let data;
  if(url.endsWith('/v5/product/info/prices'))data={items:[{product_id:77,price:{min_price:minimum,price:200}}]};
  else if(url.endsWith('/v1/actions/products/update'))data=update;
  else if(url.endsWith('/v1/actions'))data={result:[{id:9,is_voucher_action:voucher,action_type:voucher?'VOUCHER':'DISCOUNT'}]};
  else if(url.endsWith('/v2/actions/products/deactivate'))data={product_ids:[77]};
  else throw new Error('Unexpected external call '+url);
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 };
 return {calls,deleted,env,restore(){globalThis.fetch=originalFetch;Date.now=originalNow;}};
}
async function submit(mock,body){const r=await app.request('/ozon/actions/9/price-limit',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer test-session-123456789'},body:JSON.stringify(body)},mock.env);return{status:r.status,json:await r.json()};}
test('missing numeric ceiling or effect acknowledgement never calls Seller API',async()=>{
 const m=setup();try{
  for(const body of [{product_id:77},{product_id:77,price_limit:80},{product_id:77,price_limit:0,confirm_card_price_limit:true},{product_id:77,price_limit:'1.234',confirm_card_price_limit:true}]) assert.equal((await submit(m,body)).status,409);
  assert.equal(m.calls.length,0);assert.equal(m.deleted.length,0);
 }finally{m.restore();}
});
test('actual fresh seller minimum enforces Owner80% floor; missing floor cannot become zero',async()=>{
 for(const minimum of [100,null,0]){
  const m=setup({minimum});try{
   const response=await submit(m,{product_id:77,price_limit:'79.99',confirm_card_price_limit:true});
   assert.equal(response.status,409);assert.equal(m.calls.length,1);assert.ok(m.calls[0].url.endsWith('/v5/product/info/prices'));assert.equal(m.deleted.length,0);
  }finally{m.restore();}
 }
});
test('exact floor sends explicit RUB Money without echoed stock/candidate price and returns actual membership',async()=>{
 const m=setup();try{
  const r=await submit(m,{product_id:77,price_limit:'80.00',confirm_card_price_limit:true,stock:999,action_price:1});
  assert.equal(r.status,200);assert.equal(r.json.result.membership,'active');assert.equal(r.json.result.below_seller_minimum,true);
  assert.deepEqual(m.calls[2].body,{action_id:9,products:[{product_id:77,action_price:{amount:'80.00',currency:'RUB'}}]});
  assert.deepEqual(m.deleted,['ozon:actions:v23']);assert.equal(r.json.result.card_price_limit_effect_active,true);
 }finally{m.restore();}
});
test('deactivation and warnings are not misreported as activation or suppressed',async()=>{
 const warnings=[{product_id:77,message:'platform warning'}];const m=setup({update:{active_product_ids:[],deactivated_product_ids:[77],rejected:[],warnings}});
 try{const r=await submit(m,{product_id:77,price_limit:200,confirm_card_price_limit:true});assert.equal(r.status,200);assert.equal(r.json.result.membership,'deactivated');assert.deepEqual(r.json.result.warnings,warnings);assert.equal(m.deleted.length,1);}finally{m.restore();}
});
test('rejection preserves exact reason/warnings; unknown outcome invalidates cache and forbids blind retry',async()=>{
 for(const update of [{active_product_ids:[],deactivated_product_ids:[],rejected:[{product_id:77,reason:'PRICE_TOO_HIGH'}],warnings:[{message:'notice'}]},{active_product_ids:[],deactivated_product_ids:[],rejected:[]}]){
  const m=setup({update});try{
   const r=await submit(m,{product_id:77,price_limit:200,confirm_card_price_limit:true});assert.equal(m.deleted.length,1);
   if(update.rejected.length){assert.equal(r.status,409);assert.deepEqual(r.json.result.rejected,update.rejected);assert.deepEqual(r.json.result.warnings,update.warnings);}
   else{assert.equal(r.status,502);assert.match(r.json.errors[0].message,/Refresh before any retry/);}
  }finally{m.restore();}
 }
});
test('cache failure does not hide a confirmed external result',async()=>{
 const m=setup({cacheFails:true});try{const r=await submit(m,{product_id:77,price_limit:100,confirm_card_price_limit:true});assert.equal(r.status,200);assert.equal(r.json.result.membership,'active');assert.equal(r.json.result.cache_invalidated,false);}finally{m.restore();}
});
test('only server-verified voucher deletion reaches v2; no invented nonvoucher exit price',async()=>{
 for(const voucher of [false,true]){
  const m=setup({voucher});try{
   const r=await app.request('/ozon/actions/9/products/77',{method:'DELETE',headers:{Authorization:'Bearer test-session-123456789'}},m.env);
   assert.equal(r.status,voucher?200:409);assert.equal(m.calls.length,voucher?2:1);
   if(voucher)assert.deepEqual(m.calls[1].body,{action_id:9,product_ids:[77]});
   assert.equal(m.calls.some(c=>c.url.endsWith('/v1/actions/products/update')),false);
  }finally{m.restore();}
 }
});

test("anonymous and read-only sessions cannot write a price or remove membership",async()=>{
 const m=setup({role:"manager",access:"read"});try{
  const anonymous=await app.request("/ozon/actions/9/price-limit",{method:"POST",body:"{}"},m.env);assert.equal(anonymous.status,401);
  const readOnly=await submit(m,{product_id:77,price_limit:100,confirm_card_price_limit:true});assert.equal(readOnly.status,403);
  const remove=await app.request("/ozon/actions/9/products/77",{method:"DELETE"},m.env);assert.equal(remove.status,401);assert.equal(m.calls.length,0);
 }finally{m.restore();}
});

test('official string IDs retain membership and voucher limits do not change card ceiling',async()=>{
 for(const voucher of [false,true]){
  const m=setup({voucher,update:{active_product_ids:['77'],deactivated_product_ids:[],rejected:[],warnings:[]}});
  try{const r=await submit(m,{product_id:77,price_limit:100,confirm_card_price_limit:true});assert.equal(r.status,200);assert.equal(r.json.result.membership,'active');assert.deepEqual(r.json.result.active_product_ids,['77']);assert.equal(r.json.result.card_price_limit_effect_active,!voucher);}finally{m.restore();}
 }
 const m=setup({update:{active_product_ids:[],deactivated_product_ids:['77'],rejected:[],warnings:[]}});
 try{const r=await submit(m,{product_id:77,price_limit:200,confirm_card_price_limit:true});assert.equal(r.status,200);assert.equal(r.json.result.membership,'deactivated');}finally{m.restore();}
});
