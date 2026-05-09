-- Phase 8.x — replace f4_lubertsy placeholder with real fulfillment contract №9
-- Applied directly to D1 prod via REST API on 2026-05-09.
--
-- Real contract: "Договор оказания услуг (фулфилмент) №9 от 15.07.2025"
-- Исполнитель: ИП Швалев Андрей Сергеевич (ИНН 550412856773, ОГРНИП 322440000006410)
-- Заказчик: DEE (ООО «Дас Экспертен Евразия»)
-- Срок: 1 год + автопролонгация
--
-- Identity confirmed via 34 bank transactions from Modulbank with same INN.

-- Step 1: free contract_no='9'
UPDATE contracts SET contract_no='9_TEMP' WHERE id='placeholder_f4_lubertsy_rub';

-- Step 2: clone with new clean ID and final contract_no
INSERT INTO contracts
SELECT 'dee_f4_lubertsy_009' AS id, '9' AS contract_no, partner_id, our_company_id, 
       currency, signed_date, expiry_date, incoterms, status, notes, 
       created_at, updated_at, deleted_at, unk_reference, unk_valid_until, 
       invoice_language, vat_rate, parent_contract_id, addendum_no, 
       agreement_type, contract_file_key 
FROM contracts WHERE id='placeholder_f4_lubertsy_rub';

-- Step 3: repoint dependents
UPDATE payments SET contract_id='dee_f4_lubertsy_009' WHERE contract_id='placeholder_f4_lubertsy_rub';
UPDATE operations SET contract_id='dee_f4_lubertsy_009' WHERE contract_id='placeholder_f4_lubertsy_rub';

-- Step 4: drop old placeholder row
DELETE FROM contracts WHERE id='placeholder_f4_lubertsy_rub';

-- Step 5: ensure correct fields on new row
UPDATE contracts SET 
    contract_no='9',
    signed_date=1752537600,
    notes='Договор оказания услуг (фулфилмент) №9 от 15.07.2025. Исполнитель: ИП Швалев Андрей Сергеевич (ИНН 550412856773, ОГРНИП 322440000006410). Срок 1 год с автопролонгацией. Стоимость по приложению №1: приёмка/упаковка 10 ₽/ед, короб 50 ₽/шт, хранение 15 ₽/м³/день, логистика по тарифу склада.',
    invoice_language='RU',
    vat_rate=0,
    updated_at=strftime('%s','now')
WHERE id='dee_f4_lubertsy_009';
