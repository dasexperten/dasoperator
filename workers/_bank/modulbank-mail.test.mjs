import test from "node:test";
import assert from "node:assert/strict";
import { parseModulbankMail, kopecks } from "./modulbank-mail.mjs";

const IN = `| Арам, здравствуйте! На расчётный счёт ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ" пришёл платёж: |
| + 94 623,14 р. |
| Платёж: | №660829 от 5 октября 2026 |
| От: | РВБ ООО |
| ИНН: | 9714053621 |
| КПП: | 507401001 |
| На счёт: | 40702810370010335401 |
| Назначение платежа: | «Оплата по договору б/н от 21.09.2026 за товар. Сумма 94623.14 RUB в т.ч. НДС» |
| Остаток на счёте: | 858 117,82 р. |
| Посмотреть платёж – в личном кабинете[](https://my.modulbank.ru/#/goto/finance/transaction/641c667a-08ac-42be-a86f-b4da0400919b?companyId=1ce7f375) |`;

const BATCH = `| Здравствуйте, Арам! Мы списали деньги со счёта Расчётный счёт (***5401) вашей компании ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ". |
| Платёжное поручение: | №1083 от 5 октября 2026 |
| Отправитель: | ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ" |
| Со счёта: | Расчётный счёт ***5401 |
| Получатель | ИП КИЗЕРОВ ДМИТРИЙ ВАЛЕРЬЕВИЧ ИНН: 550608490308, КПП: |
| Назначение платежа: | «Оплата по счёту № 418 от 25.09.2026.Сборка заказа ФБС Без НДС» |
| Сумма: | 1 533,06 р. |
| Исполнено: | 5 октября 2026 в 09:04 |
| Комиссия: | 0,00 р. |
| Подробная информация[](https://my.modulbank.ru/#/goto/finance/transaction/633e11f4-8b79-4980-ad18-b4da01cea089?companyId=1) |
| Платёжное поручение: | №1080 от 2 октября 2026 |
| Отправитель: | ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ" |
| Со счёта: | Расчётный счёт ***5401 |
| Получатель | ООО "КОНСОЛЬ.ПРО" ИНН: 7707418148, КПП: 771001001 |
| Назначение платежа: | «Оплата по счёту № ПС1366» |
| Сумма: | 1 000,00 р. |
| Исполнено: | 5 октября 2026 в 10:28 |
| Подробная информация[](https://my.modulbank.ru/#/goto/finance/transaction/6d14ccb6-d30a-475d-b093-b4d7027f64dc?companyId=1) |`;

const OUT = `| Здравствуйте, Арам! Платёж со счёта компании ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ" ушёл. |
| – 7 900,00 р. |
| Платёж: | №1082 от 2 октября 2026 |
| Кому: | ООО "ЕОЦ-ПАРТНЁР" |
| Со счёта: | 40702810370010335401 |
| Назначение платежа: | «Оплата по счёту № 894» |
| Комиссия: | 0,00 р. |
| Остаток на счёте: | 794 460,94 р. |
| Подробная информация – в личном кабинете[](https://my.modulbank.ru/#/goto/finance/transaction/90287e7a-702e-4377-a368-b4d70325806c?companyId=1) |`;

const FEE = `| Списана комиссия со счёта Расчётный счёт (***5401) вашей компании ООО "ДАС ЭКСПЕРТЕН ЕВРАЗИЯ". |
| Со счёта: Расчётный счёт (***5401) Сумма: 75,00 р. Назначение комиссии: Комиссия за СМС-информирование за период с 02.10.2026 по 31.10.2026. Без НДС |
| Подробная информация[](https://my.modulbank.ru/#/goto/finance/transaction/0d5bd116-7c36-43eb-8a08-b4d70287bcc0?companyId=1) |`;

test("kopecks", () => {
  assert.equal(kopecks("94 623,14"), 9462314);
  assert.equal(kopecks("75,00"), 7500);
});

test("incoming marketplace payout", () => {
  const r = parseModulbankMail(IN, { subject: "Поступление средств от РВБ ООО" });
  assert.deepEqual(r.problems, []);
  assert.equal(r.transactions.length, 1);
  const t = r.transactions[0];
  assert.equal(t.direction, "incoming");
  assert.equal(t.amount, 9462314);
  assert.equal(t.executed_at, "2026-10-05");
  assert.equal(t.contragent_name, "РВБ ООО");
  assert.equal(t.contragent_inn, "9714053621");
  assert.equal(t.external_doc_number, "660829");
  assert.equal(t.external_id, "641c667a-08ac-42be-a86f-b4da0400919b");
  assert.match(t.payment_purpose, /Оплата по договору/);
});

test("batch of outgoing payments", () => {
  const r = parseModulbankMail(BATCH, { subject: "Списание денег" });
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[0].amount, 153306);
  assert.equal(r.transactions[0].direction, "outgoing");
  assert.equal(r.transactions[0].contragent_inn, "550608490308");
  assert.equal(r.transactions[1].contragent_name, 'ООО "КОНСОЛЬ.ПРО"');
  assert.equal(r.transactions[1].external_doc_number, "1080");
  assert.equal(r.transactions[1].executed_at, "2026-10-05");
});

test("single outgoing payment", () => {
  const t = parseModulbankMail(OUT, { subject: 'Списаны средства в пользу ООО "ЕОЦ-ПАРТНЁР"' }).transactions[0];
  assert.equal(t.amount, 790000);
  assert.equal(t.direction, "outgoing");
  assert.equal(t.contragent_name, 'ООО "ЕОЦ-ПАРТНЁР"');
});

test("bank fee", () => {
  const t = parseModulbankMail(FEE, { subject: "Списана комиссия", fallbackDate: "2026-10-02" }).transactions[0];
  assert.equal(t.amount, 7500);
  assert.equal(t.direction, "outgoing");
  assert.equal(t.executed_at, "2026-10-02");
  assert.equal(t.contragent_name, "Модульбанк");
});

test("plain text without table pipes (Apps Script body) still parses", () => {
  const plain = IN.replace(/\|/g, "\n").replace(/\[\]\(([^)]*)\)/g, " <$1>");
  const r = parseModulbankMail(plain, { subject: "Поступление средств от РВБ ООО" });
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].amount, 9462314);
});
