import test from 'node:test';import assert from 'node:assert/strict';
import {requisitesQuestion} from './diana-requisites-question.mjs';
test('Owner 2026-11-13: Diana asks for exactly the missing detail',()=>{
 assert.equal(requisitesQuestion({missing_fields:['bank'],first_name:'Елена'}),'Елена, подскажите, пожалуйста, название банка для перевода по СБП?');
 assert.equal(requisitesQuestion({missing_fields:['bank','name']}),'Подскажите, пожалуйста, название банка и имя получателя для перевода по СБП?');
 assert.equal(requisitesQuestion({missing_fields:['phone','bank','name']}),'Подскажите, пожалуйста, номер телефона, название банка и имя получателя для перевода по СБП?');
 assert.ok(requisitesQuestion({foreign:true,missing_fields:['phone']}).includes('российских банков'));
 assert.equal(requisitesQuestion({missing_fields:[]}),null);
});
