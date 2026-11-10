import test from 'node:test';
import assert from 'node:assert/strict';
import {runDirect} from './diana-direct-run.mjs';
const event={cid:'chat',message_id:'incoming',event_id:'message:incoming'};
function fixture(){const stored=[];return {stored,options:{event,readOriginal:async()=>({status:'ready',messages:[{message:'PRIVATE INCOMING'}]}),decide:async()=>({action:'reply',reply:'PRIVATE OUTGOING',recipientId:'person'}),deliver:async()=>({status:'verified',outgoingId:'outgoing'}),saveProof:async proof=>stored.push(proof),acknowledge:async()=>true}};}
test('completes only after delivery proof without storing conversation text',async()=>{const f=fixture();const out=await runDirect(f.options);assert.equal(out.status,'complete');assert.doesNotMatch(JSON.stringify({out,stored:f.stored}),/PRIVATE/);});
test('payout and uncertain delivery remain pending without acknowledgment',async()=>{for(const mode of ['payout','unknown']){const f=fixture();let ack=0;f.options.acknowledge=async()=>{ack++;return true};if(mode==='payout')f.options.decide=async()=>({action:'payout',reason:'payout_handoff_pending'});else f.options.deliver=async()=>({status:'unknown'});assert.equal((await runDirect(f.options)).status,'pending');assert.equal(ack,0);assert.equal(f.stored.length,0);}});
