-- Owner 2026-10-07: dasexperten.ru sales paid through Yandex Pay are YandexKit
-- sales. The operation is named after the payment source: DASR-YYYYMMDD →
-- YANDEXKIT-YYYYMMDD, and the counterparty shows as YandexKit.
-- yandex-pay-sale.ts now writes YANDEXKIT- and still finds a legacy DASR- row.
-- Rollback:
--   UPDATE operations SET reference = 'DASR-' || substr(reference, 11)
--     WHERE partner_id = 'яндекс_пей_продажи_с_нашего_сайта' AND reference LIKE 'YANDEXKIT-%';
--   UPDATE partners SET trade_name = 'dasexperten.ru', abbreviation = 'DASR'
--     WHERE id = 'яндекс_пей_продажи_с_нашего_сайта';
UPDATE operations
SET reference = 'YANDEXKIT-' || substr(reference, 6),
    updated_at = strftime('%s', 'now')
WHERE partner_id = 'яндекс_пей_продажи_с_нашего_сайта'
  AND reference LIKE 'DASR-%';
UPDATE partners
SET trade_name = 'YandexKit', abbreviation = 'YANDEXKIT'
WHERE id = 'яндекс_пей_продажи_с_нашего_сайта';
