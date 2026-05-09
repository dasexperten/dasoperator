-- =============================================================================
-- Migration 0009 — invoicer roles + manufacturer bank routes seed + seq_is
-- =============================================================================
-- Reproduces a batch of changes Aram applied directly to remote D1 via the
-- D1 REST API on 2026-05-05 while wiring the invoicer engine (PR #36).
-- This file exists so a fresh clone of das_erp_dev (or a future spin-up of
-- a sister DB) lands in the same state without anyone re-running those
-- ad-hoc commands.
--
-- Concretely:
--
--   1. manufacturers gets three new columns:
--        slug                       — slug used in chat / contacts skill
--        is_packaging_manufacturer  — does it physically package goods
--        is_legal_seller            — can it appear as seller on invoices
--   2. products gets packaging_manufacturer_id (FK manufacturers.id) so we
--      can model a separate "packaging facility" from the legal seller.
--   3. operations gets two flags:
--        dei_layer       — is this a sale that routes Factory→DEI→DEE
--        legal_seller_id — explicit override for who is the legal seller
--                          on the resulting documents (e.g. honghui)
--   4. The four manufacturer_bank_routes Aram has IBANs for today are
--      seeded:
--        Honghui Route A — VTB Shanghai, CIS payers
--        Jinxia  Route A — VTB Shanghai, CIS payers
--        Jinxia  Route B — ICBC Yangzhou, international payers
--        WDAA    default — CCB Asia Hong Kong
--      (Honghui Route B and Meizhiyuan default are deliberately absent;
--       the engine HARD-STOPs on those — see PR description.)
--   5. Manufacturers slugs + role flags are populated:
--        mfr_honghui    → guangzhou-honghui, packaging=0, seller=1
--        mfr_jinxia     → yangzhou-jinxia,   packaging=1, seller=1
--        mfr_meizhiyuan → meizhiyuan,        packaging=1, seller=1
--        mfr_wdaa       → wdaa,              packaging=1, seller=1
--   6. seq_is row is added so the invoicer engine can issue IS references
--      (IS-YYYYMM-NNNN format, mirrors CI/PL).
--
-- Idempotency note for the existing remote D1: the columns and rows above
-- are already in place. Re-running the ALTER / INSERT statements there
-- will fail with "duplicate column" / "UNIQUE constraint" errors. That is
-- expected — this file is intended for fresh clones, NOT for re-application
-- to the live database. The PR #36 description spells this out explicitly
-- in the "Reviewer notes" section.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. manufacturers — slug + role flags
-- -----------------------------------------------------------------------------
ALTER TABLE manufacturers ADD COLUMN slug TEXT;
ALTER TABLE manufacturers ADD COLUMN is_packaging_manufacturer INTEGER NOT NULL DEFAULT 0
  CHECK (is_packaging_manufacturer IN (0, 1));
ALTER TABLE manufacturers ADD COLUMN is_legal_seller INTEGER NOT NULL DEFAULT 0
  CHECK (is_legal_seller IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_manufacturers_slug ON manufacturers(slug);

-- -----------------------------------------------------------------------------
-- 2. products — packaging_manufacturer_id
-- -----------------------------------------------------------------------------
-- D1 supports ALTER TABLE ADD COLUMN with FK references in the column
-- definition. The FK is enforced only when foreign_keys pragma is on (off by
-- default in D1) — the column itself is what matters for the engine.
ALTER TABLE products ADD COLUMN packaging_manufacturer_id TEXT
  REFERENCES manufacturers(id);
CREATE INDEX IF NOT EXISTS idx_products_packaging_mfr
  ON products(packaging_manufacturer_id);

-- -----------------------------------------------------------------------------
-- 3. operations — dei_layer + legal_seller_id
-- -----------------------------------------------------------------------------
ALTER TABLE operations ADD COLUMN dei_layer INTEGER NOT NULL DEFAULT 0
  CHECK (dei_layer IN (0, 1));
ALTER TABLE operations ADD COLUMN legal_seller_id TEXT
  REFERENCES manufacturers(id);

-- -----------------------------------------------------------------------------
-- 4. manufacturer slug + role updates (the four mfr_* rows seeded in 0002)
-- -----------------------------------------------------------------------------
UPDATE manufacturers
   SET slug = 'guangzhou-honghui',
       is_packaging_manufacturer = 0,
       is_legal_seller = 1,
       updated_at = strftime('%s','now')
 WHERE id = 'mfr_honghui';

UPDATE manufacturers
   SET slug = 'yangzhou-jinxia',
       is_packaging_manufacturer = 1,
       is_legal_seller = 1,
       updated_at = strftime('%s','now')
 WHERE id = 'mfr_jinxia';

UPDATE manufacturers
   SET slug = 'meizhiyuan',
       is_packaging_manufacturer = 1,
       is_legal_seller = 1,
       updated_at = strftime('%s','now')
 WHERE id = 'mfr_meizhiyuan';

UPDATE manufacturers
   SET slug = 'wdaa',
       is_packaging_manufacturer = 1,
       is_legal_seller = 1,
       updated_at = strftime('%s','now')
 WHERE id = 'mfr_wdaa';

-- -----------------------------------------------------------------------------
-- 5. manufacturer_bank_routes seed — 4 routes
-- -----------------------------------------------------------------------------
-- Note: bank account numbers and SWIFT codes here come from the live remote
-- D1 state. Aram seeded them via REST API; this is the verbatim copy.
-- account_holder string format is the legal name as it should print on the
-- "Beneficiary" line of the IS document.
INSERT INTO manufacturer_bank_routes
  (id, manufacturer_id, route_code, payer_jurisdiction_filter,
   bank_name, bank_address, account_number, iban, swift,
   account_holder, currency, notes,
   created_at, updated_at)
VALUES
  ('mbr_honghui_a', 'mfr_honghui', 'A', 'RU,CIS',
   'Bank of VTB (Pao) Shanghai Branch', 'Shanghai, China',
   NULL, NULL, 'VTBRCNS2',
   'GUANGZHOU HONGHUI DAILY TECHNOLOGY CO., LTD.', 'CNY',
   'Honghui Route A — used when DEE / CIS entities pay.',
   strftime('%s','now'), strftime('%s','now')),
  ('mbr_jinxia_a', 'mfr_jinxia', 'A', 'RU,CIS',
   'Bank of VTB (Pao) Shanghai Branch', 'Shanghai, China',
   NULL, NULL, 'VTBRCNS2',
   'YANGZHOU JINXIA PLASTIC PRODUCTS & RUBBER CO., LTD', 'CNY',
   'Jinxia Route A — used when DEE / CIS entities pay.',
   strftime('%s','now'), strftime('%s','now')),
  ('mbr_jinxia_b', 'mfr_jinxia', 'B', 'INTERNATIONAL',
   'Industrial and Commercial Bank of China, Yangzhou Branch',
   'Yangzhou, China',
   '1108260319914106771', NULL, 'ICBKCNBJYZU',
   'YANGZHOU JINXIA PLASTIC PRODUCTS & RUBBER CO., LTD', 'USD',
   'Jinxia Route B — used when DEI / DEASEAN / DEC pay.',
   strftime('%s','now'), strftime('%s','now')),
  ('mbr_wdaa_default', 'mfr_wdaa', 'default', NULL,
   'China Construction Bank (Asia)', 'Hong Kong',
   '0004 0282 3327', NULL, 'CCBQHKAXXXX',
   'WDAA Limited', 'USD',
   'WDAA single route — used by all payers.',
   strftime('%s','now'), strftime('%s','now'));

-- -----------------------------------------------------------------------------
-- 6. seq_is — Invoice Specification sequence (IS-YYYYMM-NNNN, padding=4)
-- -----------------------------------------------------------------------------
INSERT INTO sequences (id, description, next_number, padding, format_example, updated_at)
VALUES ('seq_is', 'Invoice Specification global counter', 1, 4, 'IS-202605-0001',
        strftime('%s','now'));

-- =============================================================================
-- END OF MIGRATION 0009
-- =============================================================================
