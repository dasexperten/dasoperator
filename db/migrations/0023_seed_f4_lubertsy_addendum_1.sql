-- Phase 8.x — F4 Lubertsy addendum №1 to contract №9
-- Applied directly to D1 prod via REST API on 2026-05-09.
--
-- Source: ДопСоглашение №1 от 22.04.2026 к Договору №9 от 15.07.2025.
-- New pricing blocks A/Б/В/Г/Д with itemized service rates.

INSERT INTO contracts
(id, contract_no, partner_id, our_company_id, currency, signed_date, status, notes,
 created_at, updated_at, agreement_type, vat_rate, parent_contract_id, addendum_no, invoice_language)
VALUES
('dee_f4_lubertsy_009_a1', '9/A1', 'f4_lubertsy', 'dee', 'RUB', 1777190400, 'active',
'Допсоглашение №1 от 22.04.2026. Новая редакция Приложения №1 (тарифы): Блок А заводской комплект 10 ₽/ед; Блок Б наборы щёток (2 шт — 12 ₽, 4 шт — 14 ₽); Блок В без полного цикла (короб 35 ₽, квант 3 ₽); Блок Г общие (короб 50 ₽, хранение 15 ₽/м³/день); Блок Д логистика (Электросталь 4070/3000/2800/2000, Тула/Рязань 6050/3000/2800/2000 ₽ за паллет). Изменение тарифов — только новым допсоглашением, уведомление за 30 дней через Telegram.',
strftime('%s','now'), strftime('%s','now'), 'addendum', 0, 'dee_f4_lubertsy_009', '1', 'RU');
