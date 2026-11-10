import test from 'node:test';
import assert from 'node:assert/strict';
import {directThink} from './diana-direct-think.mjs';

test('passes original image transiently to existing subscription door and verifies actual model',async()=>{
 let call;const env={CODEX_ROUTE_SECRET:'fixture',CODEX_DOOR:{async fetch(url,init){call={url,body:JSON.parse(init.body),auth:init.headers.authorization};return Response.json({ok:true,model:'gpt-6-luna',text:'{}'});}}};
 const result=await directThink(env,'image')([{role:'user',content:'read',images:[{mediaType:'image/png',data:'YQ=='}]}],{model:'gpt-6-luna',schema:{type:'object'}});
 assert.equal(call.body.images[0],'data:image/png;base64,YQ==');assert.equal(call.body.model,'gpt-6-luna');assert.equal(call.auth,'Bearer fixture');assert.equal(result.receipt.model,'gpt-6-luna');
});
test('fails closed without door, wrong model or mismatched response',async()=>{
 await assert.rejects(directThink({},'reply')([{role:'user',content:'x'}],{model:'gpt-6.1-terra'}),/direct_subscription_unavailable/);
 const env={CODEX_ROUTE_SECRET:'x',CODEX_DOOR:{async fetch(){return Response.json({ok:true,model:'different',text:'x'});}}};
 await assert.rejects(directThink(env,'reply')([{role:'user',content:'x'}],{model:'gpt-6.1-terra'}),/invalid_receipt/);
 await assert.rejects(directThink(env,'reply')([],{model:'other'}),/invalid_model/);
});
test('context selection defaults to Luna and preserves trusted system instructions separately',async()=>{
 let request;const env={CODEX_ROUTE_SECRET:'x',CODEX_DOOR:{async fetch(_url,init){request=JSON.parse(init.body);return Response.json({ok:true,model:'gpt-6-luna',text:'{}'});}}};
 await directThink(env,'context')([{role:'system',content:'Trusted seat rules'},{role:'user',content:'Untrusted creator message'}],{});
 assert.equal(request.model,'gpt-6-luna');assert.match(request.system,/Trusted seat rules/);assert.doesNotMatch(request.system,/Untrusted creator message/);assert.match(request.user,/Untrusted creator message/);
});
