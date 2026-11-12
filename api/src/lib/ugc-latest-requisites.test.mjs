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
 // Owner 2026-11-12: «remove the name rule» — a surname with initials is still a name; the button appears.
 assert.equal(latestRequisites([m('a','89990000000 Сбер Жукова Т.Б','00')])?.first_name,'Жукова');
});

test('new ambiguous phone never falls back to older bank or recipient details',()=>{
 assert.equal(latestRequisites([m('a','89990000000 Сбер Анна','00'),m('b','89991111111 Сбер или ТБанк Елена','20')]),null);
 const r=latestRequisites([m('a','89990000000 Сбер Анна','00'),m('b','89991111111 ТБанк Елена','01')]);assert.equal(r.phone,'+79991111111');assert.equal(r.first_name,'Елена');
});

test('Owner 2026-11-11 (elwira.karimova2013): a lowercase first name after the surname is still read', () => {
  const r = latestRequisites([{ id: '2', direction: 'in', text: '89177969694 сбербанк\nКаримова эльвира васфирахмановна', created_at: '2026-11-08T14:07:00Z' }]);
  assert.equal(r.first_name, 'Эльвира');
  assert.equal(r.phone, '+79177969694');
});

test('Owner 2026-11-12 irina_beauty_smr: a first name ending in -ина with a patronymic is a name, not a surname', () => {
  const r = latestRequisites([{id:'i1',direction:'in',text:'89179990011 Сбербанк Ирина Леонидовна Т.',created_at:'2026-11-12T05:20:00Z'}]);
  assert.equal(r?.first_name, 'Ирина');
  const m = latestRequisites([{id:'m1',direction:'in',text:'89179990011 Т-Банк Марина',created_at:'2026-11-12T05:20:00Z'}]);
  assert.equal(m?.first_name, 'Марина');
});
