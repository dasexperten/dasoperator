import test from 'node:test';import assert from 'node:assert/strict';import {closedEvent} from './dieter-runtime-diagnose.mjs';
test('historical diagnostics classify failures without printing private exception bodies',()=>{
 const value=closedEvent({timestamp:1,$workers:{entrypoint:'CodexRunner',outcome:'exception'},source:{message:'Error proxying request: connection lost secret-fixture',prompt:'private-message'}});
 assert.deepEqual(value.classes,['connection_lost','proxy_failure']);assert.ok(!JSON.stringify(value).includes('secret-fixture'));assert.ok(!JSON.stringify(value).includes('private-message'));
});
test('only Dieter operation logs leave request metadata',()=>{
 assert.equal(closedEvent({source:{message:JSON.stringify({op:'reply',req:'private',text:'private'})}}),null);
 const value=closedEvent({source:{message:JSON.stringify({op:'dieter_round',req:'dieter-47477a45-18cf-4ba',run_ms:10,error:'secret-fixture'})}});
 assert.equal(value.request_ref,'dieter-47477a45-18cf-4ba');assert.ok(!JSON.stringify(value).includes('secret-fixture'));
});
