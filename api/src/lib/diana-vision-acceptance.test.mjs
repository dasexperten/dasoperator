import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreCase} from './diana-vision-acceptance.mjs';
const check={kind:'basket',product:'yes',seller:'yes',amount:'yes',observed:{price:'394 ₽',currency:'RUB'}};
test('matching labels pass',()=>assert.equal(scoreCase({file:'a.png',kind:'basket',product:'yes',seller:'yes',price_minor:39400,currency:'RUB'},check).pass,true));
test('wrong amount fails and is flagged as confidently wrong',()=>{const r=scoreCase({file:'a.png',price_minor:45300},check);assert.deepEqual(r.fails,['price']);assert.equal(r.wrongConfident,true);});
test('honest unknown amount fails but is not confidently wrong',()=>{const r=scoreCase({file:'a.png',price_minor:39400},{...check,amount:'unknown',observed:{price:null}});assert.equal(r.pass,false);assert.equal(r.wrongConfident,false);});
