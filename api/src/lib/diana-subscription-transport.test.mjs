import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionInference } from './diana-subscription-transport.mjs';
const receipt={transport:'claude-code-native',auth:'subscription',model:'claude-sonnet-5-5',requestId:'r1',operation:'image'};
const options={requestId:'r1',operation:'image'};
test('image bytes and all context text cross the binding unchanged',async()=>{
 const messages=[{role:'user',content:[{type:'text',text:'a'.repeat(50000)},{type:'image_url',image_url:{url:'data:image/png;base64,ABC'}}]}];
 const result=await subscriptionInference(messages,{...options,binding:{fetch:async(url,init)=>{
  assert.equal(url,'https://subscription.internal/infer');assert.deepEqual(JSON.parse(init.body).messages,messages);
  return Response.json({text:'verified',receipt});
 }}});assert.equal(result.text,'verified');
});
test('no binding, failure, or incorrect receipt cannot silently use paid routes',async()=>{
 await assert.rejects(subscriptionInference([],{...options}),/not_configured/);
 for(const response of [new Response('',{status:503}),Response.json({text:'yes',receipt:{...receipt,auth:'api'}}),Response.json({text:'yes',receipt:{...receipt,requestId:'other'}}),Response.json({text:'',receipt})]){
  let calls=0;
  await assert.rejects(subscriptionInference([],{...options,binding:{fetch:async()=>{calls++;return response;}}}),/subscription/);
  assert.equal(calls,1);
 }
});
