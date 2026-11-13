import test from 'node:test';import assert from 'node:assert/strict';
import {agreedExtra} from './ugc-agreed-extra.mjs';
const m=(id,direction,text,t)=>({id,direction,text,created_at:t});
const lona=[m('1','out','а если мы  в порядке исключения дадим вам еще и сумму','2026-11-11T12:13:00Z'),
 m('2','in','Для меня комфортная стоимость такого ролика с учётом разработки сценария, съёмки и монтажа — 2000 рублей','2026-11-12T07:50:00Z'),
 m('3','in','Если вы не согласны - готова вернуть оплату и пасту','2026-11-12T07:50:30Z'),
 m('4','out','Мы согласны.','2026-11-12T11:51:00Z'),
 m('5','in','Отлично, рада, что договорились! после получения оплаты приступлю к съемке','2026-11-13T03:30:00Z')];
test('Owner 2026-11-13 (lona.lnk): «Мы согласны» on her 2000 рублей makes a 2000 ₽ deal',()=>{
 const d=agreedExtra(lona);assert.equal(d.amount_minor,200000);assert.equal(d.agreement_message_id,'4');
});
test('a paid deal is not repeated',()=>{
 assert.equal(agreedExtra([...lona,m('6','out','Перевели 2000 ₽ по СБП. Проверьте, пожалуйста.','2026-11-13T07:00:00Z')]),null);
});
test('our question «согласны?» and her «согласна» are never an agreement',()=>{
 assert.equal(agreedExtra([m('1','in','хочу 500 р','2026-11-12T10:00:00Z'),m('2','out','Мы возмещаем цену со скидкой, согласны?','2026-11-12T10:01:00Z'),m('3','in','Согласна','2026-11-12T10:02:00Z')]),null);
});
test('amount named in the agreement itself wins; 1 тыс counts',()=>{
 assert.equal(agreedExtra([m('1','in','доплатите 1 тыс','2026-11-12T10:00:00Z'),m('2','out','Хорошо, мы согласны на 700 ₽','2026-11-12T10:01:00Z')]).amount_minor,70000);
 assert.equal(agreedExtra([m('1','in','доплатите 1 тыс','2026-11-12T10:00:00Z'),m('2','out','Мы согласны','2026-11-12T10:01:00Z')]).amount_minor,100000);
 assert.equal(agreedExtra([m('1','in','доплатите 1 тыс','2026-11-12T10:00:00Z'),m('2','out','Договорились','2026-11-12T10:01:00Z')]),null);
});
test('Diana\'s «договорились» about a date and a cart price are never a deal',()=>{
 assert.equal(agreedExtra([m('1','in','426₽','2026-11-12T07:00:00Z'),m('2','in','В понедельник','2026-11-12T07:57:00Z'),m('3','out','Договорились, Елена, ждём ролик в понедельник)','2026-11-12T08:02:00Z')]),null);
 assert.equal(agreedExtra([m('1','in','426₽','2026-11-12T07:00:00Z'),m('2','out','Мы согласны.','2026-11-12T08:02:00Z')]),null);
});
test('no amount, or over the 2999 ₽ ceiling — no button',()=>{
 assert.equal(agreedExtra([m('1','in','можно вторую пасту?','2026-11-12T10:00:00Z'),m('2','out','Мы согласны.','2026-11-12T10:01:00Z')]),null);
 assert.equal(agreedExtra([m('1','in','мой прайс 5000 р','2026-11-12T10:00:00Z'),m('2','out','Мы согласны.','2026-11-12T10:01:00Z')]),null);
});
