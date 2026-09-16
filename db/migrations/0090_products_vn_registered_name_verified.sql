-- 0090 — Vietnamese registered names verified against the official DAV receipts
-- Valentina Korolyeva 2026-09-16. Source: "PCB_DAS EXPERTEN <NAME> TOOTHPASTE.pdf" on the company
-- Google Drive (Phiếu công bố, field 1.2 Product Name, acknowledged 26/5/2026).
-- Verified word for word: DETOX 324890, GINGER FORCE 324869, COCO CANNABIS 324865 (rows from 0089 unchanged),
-- TERMO 324866, SYMBIOS 324867 (added here). INNOWEISS 329880 and SCHWARZ 329881 — receipt PDF not found; name stays per pattern.
UPDATE products SET vn_registered_name='DAS EXPERTEN TERMO TOOTHPASTE', vn_notification_no='324866/26/CBMP-QLD' WHERE id='de209';
UPDATE products SET vn_registered_name='DAS EXPERTEN SYMBIOS TOOTHPASTE', vn_notification_no='324867/26/CBMP-QLD' WHERE id='de206';
