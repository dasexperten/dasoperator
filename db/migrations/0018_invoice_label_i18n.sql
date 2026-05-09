-- Migration 0018 — invoice_label internationalization
-- =============================================================================
-- Reason
--   Until now `products.invoice_label` was a single string. Documents need it
--   in different languages depending on context:
--     CI/PL → language of the partner (preferred_invoice_language)
--     UPD/TN → always RU (Russian tax / transport doc)
--     IS    → trilingual (RU + EN + CN) — Russian customs spec rendered as
--             a stacked cell across three lines
--
-- What this migration does
--   1. Adds three nullable text columns: invoice_label_ru / _en / _cn
--   2. Backfills `invoice_label_en` from the existing `invoice_label`
--      so that English documents keep working immediately.
--   3. Leaves `invoice_label` untouched as a deprecated fallback. Code
--      should prefer the localized columns and fall back only when both
--      the chosen language column and `_en` are NULL.
-- =============================================================================

ALTER TABLE products ADD COLUMN invoice_label_ru TEXT;
ALTER TABLE products ADD COLUMN invoice_label_en TEXT;
ALTER TABLE products ADD COLUMN invoice_label_cn TEXT;

UPDATE products
SET invoice_label_en = invoice_label
WHERE invoice_label IS NOT NULL
  AND invoice_label != ''
  AND deleted_at IS NULL;
