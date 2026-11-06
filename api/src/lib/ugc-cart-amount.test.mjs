import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCartAmount } from './ugc-cart-amount.mjs';
const at='2026-11-06T13:15:09Z';
const basket={kind:'basket',product:'yes',amount:'yes',seller:'unknown',unresolved_required:[],label:`Скриншот из входящего сообщения ${at}, вложение 1.`,observed:{price:'367',currency:'RUB'}};
const receipt=check=>({status:'yes',checks:[check]});
test('requisites reuse the already-read current basket, including kopecks',()=>{
 assert.equal(confirmedCartAmount(receipt(basket),at),36700);
 assert.equal(confirmedCartAmount(receipt({...basket,observed:{price:'367,50 ₽',currency:'₽'}}),at),36750);
});
test('new attachments and uncertain or non-basket evidence never inherit an old price',()=>{
 assert.equal(confirmedCartAmount(receipt(basket),'2026-11-06T13:21:24Z'),null);
 for(const change of [{kind:'order'},{product:'unknown'},{amount:'unknown'},{seller:'no'},{unresolved_required:['contradictory_evidence']},{observed:{price:'367 или 438',currency:'RUB'}},{observed:{price:'367',currency:'USD'}}])
  assert.equal(confirmedCartAmount(receipt({...basket,...change}),at),null);
 assert.equal(confirmedCartAmount({status:'unknown',checks:[basket]},at),null);
 assert.equal(confirmedCartAmount({status:'yes',checks:[basket,{kind:'other'}]},at),null);
});
