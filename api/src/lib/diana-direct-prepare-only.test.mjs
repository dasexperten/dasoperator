import test from 'node:test';
import assert from 'node:assert/strict';
import {runDirect} from './diana-direct-run.mjs';
const event={cid:'chat',message_id:'incoming',event_id:'message:incoming'};
function fixture(){const stored=[];return {stored,options:{event,readOriginal:async()=>({status:'ready',messages:[{message:'PRIVATE INCOMING'}]}),decide:async()=>({action:'reply',reply:'PRIVATE OUTGOING',recipientId:'person'}),deliver:async()=>({status:'verified',outgoingId:'outgoing'}),saveProof:async proof=>stored.push(proof),acknowledge:async()=>true}};}
test('completes only after delivery proof without storing conversation text',async()=>{const f=fixture();const out=await runDirect(f.options);assert.equal(out.status,'complete');assert.doesNotMatch(JSON.stringify({out,stored:f.stored}),/PRIVATE/);});
test('payout and uncertain delivery remain pending without acknowledgment',async()=>{for(const mode of ['payout','unknown']){const f=fixture();let ack=0;f.options.acknowledge=async()=>{ack++;return true};if(mode==='payout')f.options.decide=async()=>({action:'payout',reason:'payout_handoff_pending'});else f.options.deliver=async()=>({status:'unknown'});assert.equal((await runDirect(f.options)).status,'pending');assert.equal(ack,0);assert.equal(f.stored.length,0);}});


test('payout callback receives originals in memory, prepares only approval and never sends or acknowledges',async()=>{
 const f=fixture();f.options.decide=async()=>({action:'payout',reason:'payout_handoff_pending'});let n=0;
 f.options.handoffPayout=async({source,event:e})=>{n++;assert.equal(source.messages[0].message,'PRIVATE INCOMING');assert.equal(e.event_id,event.event_id);return{status:'registered',payout_id:'p1',amount_minor:48900,private_text:'PRIVATE'};};
 f.options.deliver=async()=>assert.fail('no message on preparation');f.options.acknowledge=async()=>assert.fail('no answered ACK on preparation');
 const out=await runDirect(f.options);assert.equal(n,1);assert.deepEqual(out,{status:'prepared',reason:'payout_awaiting_owner',payout_id:'p1',amount_minor:48900});assert.equal(f.stored.length,0);assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);
});
test('payout preview and superseded source never invoke financial preparation',async()=>{
 for(const kind of ['preview','superseded']){const f=fixture();f.options.event={...event,dryRun:kind==='preview'};f.options.decide=async()=>({action:'payout',reason:'payout_handoff_pending'});if(kind==='superseded')f.options.readOriginal=async()=>({status:'superseded'});f.options.handoffPayout=async()=>assert.fail('no intake');await runDirect(f.options);assert.equal(f.stored.length,0);}
});
test('incomplete or invalid payout preparation cannot claim an approval or payment',async()=>{
 const f=fixture();f.options.decide=async()=>({action:'payout'});f.options.deliver=async()=>assert.fail('no unsolicited payment claim');f.options.handoffPayout=async()=>({status:'incomplete',missing_fields:['amount']});assert.deepEqual(await runDirect(f.options),{status:'pending',reason:'payout_missing_fields'});
 f.options.handoffPayout=async()=>({status:'registered',payout_id:'p1',amount_minor:0});await assert.rejects(runDirect(f.options),/receipt_invalid/);
});

test('explicit prepare-only uses verified handoff without deciding, sending, proof or ACK',async()=>{
 const f=fixture();f.options.event={...event,preparePayoutOnly:true};f.options.decide=async()=>assert.fail('no ordinary reply decision');f.options.deliver=async()=>assert.fail('no outgoing');f.options.saveProof=async()=>assert.fail('no delivered proof');f.options.acknowledge=async()=>assert.fail('no ACK');f.options.handoffPayout=async()=>({status:'registered',payout_id:'p1',amount_minor:48900});
 assert.equal((await runDirect(f.options)).status,'prepared');
 f.options.event.dryRun=true;f.options.handoffPayout=async()=>assert.fail('dry run cannot save');await runDirect(f.options);
});
test('only prepare-only exposes allowlisted closed handoff diagnostic, never arbitrary text',async()=>{const allowed=['payout_original_media_unresolved','payout_amount_unconfirmed','payout_requisites_unconfirmed','payout_original_changed','payout_cycle_already_processed','payout_existing_amount_conflict','payout_intake_incomplete'];for(const reason of [...allowed,'PRIVATE RAW BANK ERROR']){const f=fixture();f.options.event={...event,preparePayoutOnly:true};f.options.handoffPayout=async()=>({status:'pending',reason});const out=await runDirect(f.options);assert.equal(out.prepare_diagnostic,allowed.includes(reason)?reason:undefined);assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);}const f=fixture();f.options.decide=async()=>({action:'payout'});f.options.handoffPayout=async()=>({status:'incomplete',reason:allowed[0]});assert.equal((await runDirect(f.options)).prepare_diagnostic,undefined);});
