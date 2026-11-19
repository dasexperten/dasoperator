import test from 'node:test';
import assert from 'node:assert/strict';
import {saysTransferSent,transferMessage} from './ugc-manual-transfer.mjs';

test('the Owner\'s words about a sent transfer are recognised',()=>{
  for(const t of ['перевод отправили','Перевод вам отправили, проверьте','Отправили перевод с личного номера','Перевели 489 ₽','Оплатили, проверьте пожалуйста','деньги отправили','Отправили частным переводом','Отправили вам личным переводом, проверьте'])assert.equal(saysTransferSent(t),true,t);
});
test('a promise, a question or a denial is never a payment',()=>{
  for(const t of ['Директор отправит перевод сам со своего номера','перевод отправили?','мы ещё не перевели','Пока не оплатили','Переведём сегодня','отправим перевод завтра','Мы отправили перевод, но банк его отклонил. Подскажите другой банк','Перевод не прошёл','','Спасибо за ролик!','Отправили частным переводом?','Отправим частным переводом','Отправили частным переводом, но банк отклонил'])assert.equal(saysTransferSent(t),false,t);
});
test('only our own message after the decline counts',()=>{
  const ours=['page','brand'];
  const failedAt='2026-11-14T10:36:26.147Z';
  const messages=[
    {id:'a',from:{id:'page'},created_time:'2026-11-14T09:00:00+0000',message:'перевели 489 ₽'},
    {id:'b',from:{id:'blogger'},created_time:'2026-11-14T12:00:00+0000',message:'перевод отправили'},
    {id:'c',from:{id:'page'},created_time:'2026-11-14T12:30:00+0000',message:'Директор отправит сам'},
    {id:'d',from:{id:'brand'},created_time:'2026-11-14T13:00:00+0000',message:'перевод отправили'},
  ];
  assert.equal(transferMessage(messages,ours,failedAt)?.id,'d');
  assert.equal(transferMessage(messages.slice(0,3),ours,failedAt),null);
  assert.equal(transferMessage(messages,ours,null),null);
  assert.equal(transferMessage(messages,ours,failedAt,['d']),null);
});
