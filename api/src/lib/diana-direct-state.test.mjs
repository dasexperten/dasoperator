import test from 'node:test';
import assert from 'node:assert/strict';
import {directOutcomeState} from './diana-direct-state.mjs';
test('temporary image failure retries once per three minutes and becomes owned review after third attempt',()=>{
 assert.deepEqual(directOutcomeState({status:'pending',reason:'original_image_unreadable'},1,1000),{status:'pending',reason:'original_image_unreadable',attempt:1,retry_at:181000});
 const result=directOutcomeState({status:'pending',reason:'original_image_unreadable'},3,1000);assert.equal(result.status,'needs_review');assert.equal(result.review_owner,'diana-helios');assert.equal(result.review_since_ms,1000);
});
test('unresolved payout or uncertain delivery remains visible and cannot be silently treated as complete',()=>{
 for(const reason of ['payout_handoff_pending','delivery_unknown','diana_wait'])assert.equal(directOutcomeState({status:'pending',reason},1,0).status,'needs_review');
});
