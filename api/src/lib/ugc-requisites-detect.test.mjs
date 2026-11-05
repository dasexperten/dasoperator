import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRequisites, UNCONFIRMED_MINOR } from './ugc-requisites-detect.mjs';

test('mis.ludmilo4ka 06.11: phone, bank and name in three messages', () => {
  const r = detectRequisites(['89014929726', 'Сбер', 'Людмила Игоревна з']);
  assert.equal(r.phone, '+79014929726');
  assert.equal(r.bank, '100000000111');
  assert.equal(r.first_name, 'Людмила');
  assert.equal(r.patronymic, 'Игоревна');
  assert.equal(r.last_name, 'З');
  assert.equal(r.amount_minor, UNCONFIRMED_MINOR);
});

test('yana_anankinaa 05.11: one message, no surname', () => {
  const r = detectRequisites(['89992204890\nЯна Геннадьевна \nТ-банк']);
  assert.equal(r.phone, '+79992204890');
  assert.equal(r.bank, '100000000004');
  assert.equal(r.first_name, 'Яна');
  assert.equal(r.patronymic, 'Геннадьевна');
  assert.equal(r.last_name, null);
});

test('incomplete requisites register nothing', () => {
  assert.equal(detectRequisites(['89014929726', 'Сбер']), null);
  assert.equal(detectRequisites(['Сбер', 'Людмила']), null);
  assert.equal(detectRequisites(['89014929726', 'Людмила']), null);
  assert.equal(detectRequisites([]), null);
  assert.equal(detectRequisites(['Да, конечно все обязательно пришлю']), null);
});

test('Abkhazia numbers stay refused', () => {
  assert.equal(detectRequisites(['+79401234567 Сбер Анна']), null);
});

test('e_zulia.20 01.11: surname first, then name and patronymic', () => {
  const r = detectRequisites(['Реквизиты \n89280000072-Асварова Зульфия Хелифовна  Сбербанк']);
  assert.equal(r.first_name, 'Зульфия');
  assert.equal(r.patronymic, 'Хелифовна');
  assert.equal(r.last_name, 'Асварова');
});
