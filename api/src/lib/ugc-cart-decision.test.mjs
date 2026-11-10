import test from 'node:test';import assert from 'node:assert/strict';import {rubMinor,incomingAmount,decideCart} from './ugc-cart-decision.mjs';
const at='2026-11-09T10:00:00Z',later='2026-11-09T11:00:00Z';
const cart={source_message_id:'cart',created_at:at,attachment_index:0,kind:'basket',product:'yes',seller:'yes',amount:'yes',observed:{price:'453',currency:'RUB'},unresolved_required:[]};
const m=text=>({id:'quote',direction:'in',text,created_at:later});
test('numeric price is structured RUB evidence, never digits from descriptions',()=>{
 assert.equal(rubMinor('453,50 ₽','₽'),45350);
 for(const [p,c] of [['453 или 497','RUB'],['SKU453','RUB'],['453','USD'],['453',''],['1','RUB']])assert.equal(rubMinor(p,c),null);
});
test('seller-only image preserves preceding verified basket, new unresolved basket does not',()=>{
 assert.equal(decideCart([cart,{...cart,source_message_id:'seller',created_at:later,kind:'other',observed:{price:null}}],null).amount_minor,45300);
 assert.equal(decideCart([cart,{...cart,created_at:later,kind:'basket',amount:'unknown'}],null).status,'pending');
 assert.equal(decideCart([{...cart,observed:{price:'453',currency:null}}],null).status,'pending');
});
test('later incoming explicit price is usable; incoming conflicting text stays pending',()=>{
 for(const text of ['Сумма 453 руб','Сумма 453руб, когда оплатите?','453руб, на Сбер или Озон?'])assert.equal(decideCart([],incomingAmount([m(text)])).amount_minor,45300,text);
 assert.equal(decideCart([{...cart,observed:{price:'447',currency:'RUB'}}],incomingAmount([{...m('453руб'),created_at:at}])).reason,'amount_conflict');
 assert.equal(decideCart([{...cart,observed:{price:'429',currency:'RUB'}}],incomingAmount([m('492р')])).amount_minor,49200);
 const asked=[{id:'question',direction:'out',text:'Подскажите артикул пасты и итоговую сумму при оформлении?',created_at:at},m('123456789012\n\n453')];
 assert.equal(decideCart([{...cart,observed:{price:'447',currency:'RUB'}}],incomingAmount(asked)).amount_minor,45300);
 assert.equal(decideCart([cart],incomingAmount([m('453₽')])).status,'confirmed');
 assert.equal(decideCart([],incomingAmount([m('123456789012\n\n453')])).status,'pending');
});
test('questions, alternatives, competing prices, arbitrary digits and outgoing claims never confirm an amount',()=>{
 for(const text of ['Можно 500 руб?','453 или 497руб','453₽ или 497₽','Цена 453 вместо 497','артикул 123453789','+79990000000'])assert.notEqual(decideCart([],incomingAmount([m(text)])).status,'confirmed',text);
 assert.equal(incomingAmount([{...m('453руб'),direction:'out'}]),null);
});


test('basket without a seller stays pending until an author answer is linked',()=>{
 const missing={...cart,seller:'unknown'};assert.equal(decideCart([missing],null).reason,'seller_unconfirmed');
 assert.equal(decideCart([missing],incomingAmount([m('453 руб')])).reason,'seller_unconfirmed');
 const answered={...missing,seller_evidence:'creator_answer',seller_source:{answer_id:'seller-answer'}};assert.equal(decideCart([answered],null).amount_minor,45300);
});
