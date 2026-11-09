import test from 'node:test';import assert from 'node:assert/strict';
import {latestRequisites} from './ugc-latest-requisites.mjs';
const m=(id,text,minute,direction='in')=>({id,text,created_at:`2026-11-09T10:${minute}:00Z`,direction});
test('latest explicit same-phone bank correction wins after our acknowledgement',()=>{
 const r=latestRequisites([m('a','89990000000 ТБанк Василиса','00'),m('ack','Данные получила','01','out'),m('b','Вы можете и на озон банк сразу перевести по этому же номеру','20')]);
 assert.equal(r.bank,'100000000273');assert.equal(r.first_name,'Василиса');assert.deepEqual(r.source_message_ids,['a','b']);
});
test('newest phone cluster wins; ordinary later Ozon order discussion does not change the bank',()=>{
 const r=latestRequisites([m('a','89990000000 Сбер Анна','00'),m('b','89991111111 ТБанк Елена','20'),m('c','Заказала на озон','21')]);
 assert.equal(r.first_name,'Елена');assert.equal(r.phone,'+79991111111');assert.equal(r.bank,'100000000004');
});
test('split short requisites work, missing name and alternate banks fail closed',()=>{
 assert.equal(latestRequisites([m('a','89990000000','00'),m('b','Сбер','01'),m('c','Людмила Игоревна з','02')]).first_name,'Людмила');
 assert.equal(latestRequisites([m('a','89990000000 Сбер','00')]),null);
 assert.equal(latestRequisites([m('a','89990000000 Сбер или ТБанк Анна','00')]),null);
 assert.equal(latestRequisites([m('a','89990000000 Сбер Жукова Т.Б','00')]),null);
});
