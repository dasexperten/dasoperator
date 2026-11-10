import test from 'node:test';import assert from 'node:assert/strict';import {sellerAnswerForBasket,SELLER_QUESTION} from './ugc-seller-followup.mjs';
const basket={created_at:'2026-11-10T08:00:00Z'},policy={sellers:[{legal_name:'ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ'}]};
const q={id:'q',direction:'out',created_at:'2026-11-10T08:01:00Z',text:SELLER_QUESTION};
const a={id:'a',direction:'in',from_username:'creator',created_at:'2026-11-10T08:02:00Z',text:'Продавец: ООО «ДАС ЭКСПЕРТЕН ЕВРАЗИЯ»'};
test('verified seller answer follows the exact question and stays linked to both originals',()=>{const result=sellerAnswerForBasket([q,a],basket,policy,'creator');assert.equal(result.answer_id,'a');assert.equal(result.question_id,'q');});
test('missing question, other sender or later correction cannot prove seller; short name stays unverified',()=>{assert.equal(sellerAnswerForBasket([a],basket,policy,'creator'),null);assert.equal(sellerAnswerForBasket([q,{...a,from_username:'other'}],basket,policy,'creator'),null);assert.equal(sellerAnswerForBasket([q,{...a,text:'Das Experten'}],basket,policy,'creator').registry_match,false);assert.equal(sellerAnswerForBasket([q,{...a,text:'не знаю'}],basket,policy,'creator'),null);assert.equal(sellerAnswerForBasket([q,a,{...a,id:'new',created_at:'2026-11-10T08:03:00Z',text:'Продавец: Другой магазин'}],basket,policy,'creator'),null);});
test('accepts a natural seller question and first line of the creator answer without inferring registry match',()=>{
 const question={...q,text:'Алина, спасибо! Подскажите, пожалуйста, как называется именно продавец в карточке товара?'};
 const answer={...a,text:'Das Experten Eurasia Ltd.\nСкрины также были сделаны из карточки товара'};
 const result=sellerAnswerForBasket([question,answer],basket,policy,'creator');assert.equal(result.name,'Das Experten Eurasia Ltd.');assert.equal(result.registry_match,false);
});
