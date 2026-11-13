import test from 'node:test';import assert from 'node:assert/strict';
import {latestRequisites,roundRequisites} from './ugc-latest-requisites.mjs';
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
 // Owner 2026-11-12: two banks named means either works; T-Bank when it is among them, otherwise the first.
 assert.equal(latestRequisites([m('a','89990000000 Сбер или ТБанк Анна','00')])?.bank,'100000000004');
 assert.equal(latestRequisites([m('a','89990000000 Анна озон тинькофф сбер','00')])?.bank,'100000000004');
 // Owner 2026-11-12: «remove the name rule» — a surname with initials is still a name; the button appears.
 assert.equal(latestRequisites([m('a','89990000000 Сбер Жукова Т.Б','00')])?.first_name,'Жукова');
});

test('new ambiguous phone never falls back to older bank or recipient details',()=>{
 const newer=latestRequisites([m('a','89990000000 Сбер Анна','00'),m('b','89991111111 Сбер или ТБанк Елена','20')]);
 assert.equal(newer?.first_name,'Елена');assert.equal(newer?.phone.replace(/\D/g,''),'79991111111'); // the newer details win whole, never mixed with the older ones
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

test('Owner 2026-11-12 svetlanakogai2018: «сбер озон» after the name still makes the button, first bank taken',()=>{
 const r=latestRequisites([m('a','89990000000 Светлана Денисовна Л сбер озон','00')]);
 assert.equal(r?.first_name,'Светлана');assert.equal(r?.bank,'100000000111');
});

test('Owner 2026-11-12 (shh_aze): our transfer message after the details means paid is paid',()=>{
 const at=Date.now()-3600000,iso=t=>new Date(t).toISOString();
 const msgs=[{id:'1',direction:'in',text:'89051234563 сбер банк Шакурова Айзиле',created_at:iso(at)},{id:'2',direction:'out',text:'Перевели 410 ₽ по СБП. Проверьте, пожалуйста.',created_at:iso(at+60000)}];
 assert.equal(latestRequisites(msgs),null);
 assert.ok(latestRequisites(msgs.slice(0,1)));
});
test('Owner 2026-11-12 (madi___na111): details 14+ days older than the newest message never make a button',()=>{
 const july={id:'1',direction:'in',text:'89281234536 Фаина А. Сбербанк',created_at:'2026-07-01T10:03:00Z'};
 assert.ok(latestRequisites([july]));
 assert.equal(latestRequisites([july,{id:'2',direction:'in',text:'Здравствуйте предлагаю сотрудничество по бартеру',created_at:'2026-11-12T16:13:00Z'}]),null);
});

test('Owner 2026-11-13: phone now, bank 20 minutes later after our question — the button is made',()=>{
 const m=[{id:'1',direction:'in',text:'+79028764000',created_at:'2026-11-12T16:50:00Z'},{id:'2',direction:'in',text:'Елена Грищенко',created_at:'2026-11-12T16:51:00Z'},
  {id:'3',direction:'out',text:'Елена, подскажите, пожалуйста, название банка для перевода по СБП?',created_at:'2026-11-12T16:53:00Z'},{id:'4',direction:'in',text:'Сбербанк',created_at:'2026-11-12T17:15:00Z'}];
 const r=latestRequisites(m);assert.ok(r);assert.equal(r.first_name,'Елена');assert.equal(r.phone,'+79028764000');
});
test('Owner 2026-11-13: exactly what is missing is named',()=>{
 assert.deepEqual(roundRequisites([{id:'1',direction:'in',text:'89028764000',created_at:'2026-11-12T16:50:00Z'}]).missing,['bank','name']);
 const g=roundRequisites([{id:'1',direction:'in',text:'Сбербанк Ирина',created_at:'2026-11-12T16:50:00Z'}]);assert.deepEqual(g.missing,['phone']);assert.equal(g.first_name,'Ирина');
 assert.deepEqual(roundRequisites([{id:'1',direction:'in',text:'Хорошо, заказываю на озоне',created_at:'2026-11-12T16:50:00Z'}]).missing,['phone','bank','name']);
});
test('Owner 2026-11-13: a Kazakhstan number is recognised as foreign',()=>{
 assert.equal(roundRequisites([{id:'1',direction:'in',text:'+7 701 234 56 78 Kaspi Айгерим',created_at:'2026-11-12T16:50:00Z'}]).foreign,true);
});
