import test from 'node:test';import assert from 'node:assert/strict';
import {alreadyPaidForTermo,verifyCartImage,chatState,subqDecide} from './subq.mjs';
const reply=answers=>async()=>({ok:true,json:async()=>({answers})});
test('Owner 2026-11-12: no SubQ key or a failed call never decides anything',async()=>{
 assert.equal(await subqDecide({},'x',{}),null);
 assert.equal(await alreadyPaidForTermo({SUBQ_API_KEY:'k'},[],'a',async()=>{throw Error('down');}),null);
 assert.equal(await alreadyPaidForTermo({SUBQ_API_KEY:'k'},[],'a',async()=>({ok:false})),null);
});
test('Owner 2026-11-12: already-paid score is read from the SubQ answer',async()=>{
 assert.equal(await alreadyPaidForTermo({SUBQ_API_KEY:'k'},[{direction:'out',text:'Перевели 410 ₽',created_at:'2026-10-24T18:39:19Z'}],'a',reply({repeat:{noul:0.93}})),0.93);
});
test('phone numbers never leave the ERP',()=>{
 assert.ok(!chatState([{direction:'in',text:'+7 902 876 40 00 Сбербанк',created_at:'2026-11-12T16:50:52Z'}]).includes('876'));
});
test('cart second check returns both scores',async()=>{
 const sent=[];const f=async(url,init)=>{sent.push(JSON.parse(init.body));return{ok:true,json:async()=>({answers:{ours:{noul:0.94},price:{noul:0.1}}})};};
 assert.deepEqual(await verifyCartImage({SUBQ_API_KEY:'k'},{mediaType:'image/jpeg',data:'AAAA'},426,f),{ours:0.94,price:0.1});
 assert.equal(sent[0].images[0].base64,'AAAA');assert.ok(sent[0].questions.price.instructions.includes('426'));
});
