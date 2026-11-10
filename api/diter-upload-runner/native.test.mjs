import test from 'node:test';import assert from 'node:assert/strict';import {nativeInfer} from './native.mjs';
test('no Diana inference or model above Terra can run',async()=>{
 for(const operation of ['image','context','reply'])await assert.rejects(nativeInfer({operation,model:'gpt-6.1-terra'}),/invalid_request/);
 await assert.rejects(nativeInfer({operation:'dieter_round',model:'gpt-6-astra'}),/invalid_request/);
 await assert.rejects(nativeInfer({operation:'dieter_round',model:'gpt-6.1-terra'},{auth:{auth_mode:'api_key'}}),/subscription_auth_required/);
});
