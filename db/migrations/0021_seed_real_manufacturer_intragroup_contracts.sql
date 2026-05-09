-- Phase 8.x — seed real manufacturer + intra-group contracts found in
-- Drive folder Agreements (https://drive.google.com/drive/u/1/folders/1izCzMpgaRU2BcQLqnbj7aIOZ_FeVRY_b)
--
-- Applied directly to D1 prod via REST API on 2026-05-09.
-- This file documents the change for repo-level reproducibility.
--
-- 5 new real contracts created:
--   1. dee_honghui_080824    — main supply DEE↔Honghui, contract 080824 (2024-04-09)
--   2. dee_honghui_080824_a1 — addendum №1 to 080824 (2026-01-01, EXW+CIF)
--   3. dee_jinxia_mf01       — main manufacturing DEE↔Jinxia, MF01-DEA/YZ (2025-01-01)
--   4. dei_dee_de0125        — trilateral assignment DEMEA→DEI↔DEE (2025-12-28)
--   5. dei_dee_06062022_a1   — addendum №1 to 06062022 (2026-01-15, extension to 2028-12-31)
--   6. dei_dee_06062022_a2   — addendum №2 to 06062022 (2026-04-09, third-party payments)
--
-- Also: restored 'dei_dee_06062022' from soft-delete (was deleted_at != NULL by mistake).

INSERT OR IGNORE INTO contracts
(id, contract_no, partner_id, our_company_id, currency, signed_date, status, notes,
 created_at, updated_at, agreement_type, vat_rate, parent_contract_id, addendum_no)
VALUES
('dee_honghui_080824', '080824', 'honghui', 'dee', 'USD', 1712620800, 'active',
 'Manufacturer supply contract DEE ↔ Guangzhou Honghui Daily Technology Co. Ltd. Base Incoterms EXW per addendum №1 dated 2026-01-01 (CIF allowed by per-shipment agreement). UNK reference 24080104192700062.',
 strftime('%s','now'), strftime('%s','now'), 'main', 0, NULL, NULL),

('dee_honghui_080824_a1', '080824/A1', 'honghui', 'dee', 'USD', 1767225600, 'active',
 'Addendum №1 to supply contract 080824. Confirms EXW Incoterms 2020 as base; allows CIF on per-shipment basis when explicitly stated in invoice/specification.',
 strftime('%s','now'), strftime('%s','now'), 'addendum', 0, 'dee_honghui_080824', '1'),

('dee_jinxia_mf01', 'MF01-DEA/YZ', 'jinxia', 'dee', 'USD', 1735689600, 'active',
 'Product Manufacturing Agreement DEE ↔ Yangzhou Jinxia Plastic Products & Rubber Co. Ltd. Brushes, floss, interdental products under Das Experten trademark.',
 strftime('%s','now'), strftime('%s','now'), 'main', 0, NULL, NULL),

('dei_dee_de0125', 'DE-0125', 'dee_partner', 'dei', 'USD', 1735344000, 'active',
 'Trilateral Assignment Agreement: DEMEA (cedent) → DEI (cessionary) ↔ DEE (debtor). Reassigns claim rights under contract 06062022 from DEMEA to DEI for currency control purposes.',
 strftime('%s','now'), strftime('%s','now'), 'annex', 0, 'dei_dee_06062022', 'DE-0125'),

('dei_dee_06062022_a1', '06062022/A1', 'dee_partner', 'dei', 'USD', 1736899200, 1861747200, 'active',
 'Addendum №1 to contract 06062022 reassigned to DEI. Confirms validity of contract under DEI as new supplier. Extends term until 2028-12-31.',
 strftime('%s','now'), strftime('%s','now'), 'addendum', 0, 'dei_dee_06062022', '1'),

('dei_dee_06062022_a2', '06062022/A2', 'dee_partner', 'dei', 'USD', 1775347200, 'active',
 'Addendum №2 to contract 06062022. Allows settlements through third parties (agents, commissioners) under written payment instructions from principal party.',
 strftime('%s','now'), strftime('%s','now'), 'addendum', 0, 'dei_dee_06062022', '2');

-- Restore main 06062022 from soft-delete
UPDATE contracts SET deleted_at = NULL WHERE id = 'dei_dee_06062022';
