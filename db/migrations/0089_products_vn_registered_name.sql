-- 0089 — Vietnamese registered product names on invoices to Vietnam
-- Justina Timber 2026-09-16 · Owner: product names on documents for Vietnam must be the names
-- registered in Vietnam — mandatory. Receipt numbers: organizacia
-- agents/valentina-korolyeva/data/VN_NOTIFICATION_STATUS_20260809.md (Owner-confirmed 11.09.2026).
-- Name pattern given by the Owner: DAS EXPERTEN <NAME> TOOTHPASTE. Word-for-word check against
-- each receipt is still open; correct a row here, not in the renderer.
ALTER TABLE products ADD COLUMN vn_registered_name TEXT;
ALTER TABLE products ADD COLUMN vn_notification_no TEXT;
UPDATE products SET vn_registered_name='DAS EXPERTEN DETOX TOOTHPASTE', vn_notification_no='324890/26/CBMP-QLD' WHERE id='de202';
UPDATE products SET vn_registered_name='DAS EXPERTEN GINGER FORCE TOOTHPASTE', vn_notification_no='324869/26/CBMP-QLD' WHERE id='de203';
UPDATE products SET vn_registered_name='DAS EXPERTEN COCO CANNABIS TOOTHPASTE', vn_notification_no='324865/26/CBMP-QLD' WHERE id='de205';
UPDATE products SET vn_registered_name='DAS EXPERTEN INNOWEISS TOOTHPASTE', vn_notification_no='329880/26/CBMP-QLD' WHERE id='de210';
