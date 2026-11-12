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
test('Owner 11.11: button without amount sends Diana one amount question and closes the event',async()=>{
 const sent=[];let proof=null;
 const r=await runDirect({event:{cid:'c',message_id:'m',event_id:'message:m'},readOriginal:async()=>({status:'ready',messages:[]}),
  decide:async()=>({action:'payout',amountQuestion:'Подскажите, пожалуйста, сумму к оплате текстом?',recipientId:'u'}),
  handoffPayout:async()=>({status:'registered_without_amount',payout_id:'p1'}),
  deliver:async(x)=>{sent.push(x.text);return{status:'verified',outgoingId:'o1'};},saveProof:async(p)=>{proof=p;},acknowledge:async()=>true});
 assert.equal(r.status,'complete');assert.equal(r.reason,'payout_button_amount_asked');assert.deepEqual(sent,['Подскажите, пожалуйста, сумму к оплате текстом?']);assert.equal(proof.payout_id,'p1');
});
test('Owner 11.11: a reply after the amount fills the waiting button first',async()=>{
 let filled=0;
 const r=await runDirect({event:{cid:'c',message_id:'m',event_id:'message:m'},readOriginal:async()=>({status:'ready',messages:[]}),
  decide:async()=>({action:'reply',reply:'Спасибо!',recipientId:'u'}),pendingAmount:async()=>true,
  handoffPayout:async()=>{filled++;return{status:'registered',payout_id:'p1',amount_minor:43200};},
  deliver:async()=>({status:'verified',outgoingId:'o'}),saveProof:async()=>{},acknowledge:async()=>true});
 assert.equal(filled,1);assert.equal(r.status,'complete');
});
test('Owner 2026-11-11: no «реквизиты получила» while the button could not be made; an honest reply still goes',async()=>{
 const f=fixture();f.options.pendingAmount=async()=>true;f.options.handoffPayout=async()=>({status:'pending',reason:'payout_original_changed'});
 f.options.decide=async()=>({action:'reply',reply:'Оксана, спасибо, реквизиты получила 🌷',recipientId:'person'});
 f.options.deliver=async()=>assert.fail('false promise must not be sent');
 assert.deepEqual(await runDirect(f.options),{status:'pending',reason:'unbacked_payment_claim'});
 const g=fixture();g.options.pendingAmount=async()=>true;g.options.handoffPayout=async()=>({status:'registered',payout_id:'p',amount_minor:41000});
 g.options.decide=async()=>({action:'reply',reply:'Оксана, спасибо, реквизиты получила 🌷',recipientId:'person'});
 assert.equal((await runDirect(g.options)).status,'complete');
});

test('Owner 2026-11-12 argnvd: a request for ideas sends the four approved cards, never an invented idea',async()=>{
 const f=fixture();let cards=0,texts=0;
 f.options.decide=async()=>({action:'cards',reason:'scenario_cards',recipientId:'person'});
 f.options.deliver=async()=>{texts++;return{status:'verified',outgoingId:'x'};};
 f.options.deliverCards=async({recipientId})=>{cards++;assert.equal(recipientId,'person');return{status:'verified',outgoingId:'c1'};};
 const out=await runDirect(f.options);
 assert.equal(out.status,'complete');assert.equal(out.reason,'scenario_cards_sent');assert.equal(cards,1);assert.equal(texts,0);
});

test('2026-11-12: a message that needs no answer is closed with a receipt, not parked',async()=>{
 const f=fixture();let proof=null,ack=0,sent=0;
 f.options.decide=async()=>({action:'none',reason:'no_reply_needed'});
 f.options.deliver=async()=>{sent++;return{status:'verified',outgoingId:'x'};};
 f.options.saveProof=async p=>{proof=p;};
 f.options.acknowledge=async()=>{ack++;return Boolean(proof?.verified);};
 const out=await runDirect(f.options);
 assert.equal(out.status,'complete');assert.equal(out.reason,'no_reply_needed');assert.equal(sent,0);assert.equal(ack,1);
});
