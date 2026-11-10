import test from 'node:test';import assert from 'node:assert/strict';import {compareVideoPayoutEvidence as compare} from './diana-video-verify.mjs';
const base=()=>({frames:[{sourceMessageId:'id',videoSha256:'abc',data:'same'}],checks:[{requisites:{holder_name:'Test',bank:'Bank',phone:'79000000000',amount:null},unresolved_required:[]}]});
test('two identical source reads produce exact facts, never an amount from a guessed basket',()=>{const r=compare(base(),base(),'id');assert.equal(r.verified,true);assert.equal(r.facts.amount,null);});
test('changed original, different digit and unresolved detail cannot verify',()=>{
 let b=base();b.frames[0].videoSha256='changed';assert.equal(compare(base(),b,'id').reason,'video_original_changed');
 b=base();b.checks[0].requisites.phone='79000000001';assert.equal(compare(base(),b,'id').verified,false);
 b=base();b.checks[0].unresolved_required=['phone'];assert.equal(compare(base(),b,'id').verified,false);
 b=base();b.frames[0].sourceMessageId='other';assert.equal(compare(base(),b,'id').verified,false);
});
test('contradicting facts from different frames stay unresolved',()=>{const a=base();a.frames.push({...a.frames[0]});a.checks.push({requisites:{phone:'79999999999'},unresolved_required:[]});assert.equal(compare(a,a,'id').verified,false);});
