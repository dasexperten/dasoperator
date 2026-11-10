import test from 'node:test';import assert from 'node:assert/strict';
import {dieterPrompt} from './dieter.mjs';
test('only an exact accepted job can become a work prompt',()=>{
 assert.throws(()=>dieterPrompt({mode:'work'},'/repo'),/exact_dieter_assignment/);
 assert.throws(()=>dieterPrompt({mode:'other'},'/repo'),/invalid_dieter_mode/);
 const p=dieterPrompt({mode:'work',assignment:{content_id:'chosen',claim_id:'lease',status:'working',task:'ACTUAL ASSIGNMENT'}},'/repo');
 assert.ok(p.includes('ACTUAL ASSIGNMENT'));assert.ok(p.includes('gpt-6.1-terra'));assert.ok(p.includes('never claim another job'));assert.ok(p.includes('No Jev, desktop/local-machine dependency'));assert.ok(p.includes('do not attempt them in this round'));assert.ok(p.includes('it is not enabled now'));
});
test('the two recovery attempts cannot upload again',()=>{
 const p=dieterPrompt({mode:'reconcile',assignment:{content_id:'chosen',claim_id:'lease',status:'working',task:'Reconcile'}},'/repo');
 assert.match(p,/MUST NOT create any new upload, container, post or publication/);assert.match(p,/No release or another claim/);
});
