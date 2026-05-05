-- =============================================================================
-- Migration 0007 — Invoicer foundation: schema rewrite for the new invoicer
-- engine (Phase 2.0c-4-schema-prep).
-- =============================================================================
-- Companion seed: 0008_seed_invoicer_data.sql.
--
-- This migration is purely additive on the production schema as it stands
-- after 0001 → 0006_payments_and_cleanup. Concretely it adds:
--
--   1. companies — banking + multilingual identity + signing authority +
--      default invoice language / incoterms.
--   2. company_bank_accounts (NEW) — DEE has 2 settlement accounts (RUB +
--      CNY/USD); a 1:1 row on companies cannot model that. Invoicer will
--      pick the right account at issue time per its account_purpose rules.
--   3. products — packaging dimensions per carton, per-unit weight, country
--      of origin, multilingual descriptions, hs_code (per-line HS column on
--      CI/PL).
--   4. manufacturers — multilingual identity, USCC tax_id, last_verified,
--      and a has_dual_route_banking flag that triggers the
--      ROUTE_REQUIRED hard-stop in the invoicer when a payer is not yet
--      mapped to Route A or B.
--   5. manufacturer_bank_routes (NEW) — Honghui and Jinxia each have two
--      routes (A for RU/CIS payers, B for international). One row per
--      route per manufacturer.
--   6. partners — local-language legal name + address, KPP/INN/OGRN,
--      payment terms, preferred incoterms / invoice language,
--      last_verified.
--   7. contracts — UNK reference + validity, invoice_language.
--   8. operations — default_document_language (final language is decided
--      by invoicer at issue time from seller + buyer + contract; this is
--      a default override).
--
-- Two product-id renames migrations are NOT in this file. ID rename and
-- the 'issued' status enum extension live in 0008's data migration so we
-- have one transactional path.
--
-- Note on file numbering: this lands as 0007 because main currently has
-- 0006_payments_and_cleanup.sql. PR #29 (draft) introduced a different
-- 0006_invoice_fields.sql containing companies banking + products.hs_code
-- + operations.status='issued'. **This migration supersedes PR #29 by
-- including those columns directly** — PR #29 should be closed once this
-- one merges (less the 'issued' status enum, which is intentionally
-- deferred until the new invoicer engine actually emits documents).
--
-- Application order (clean clone):
--   1. 0001_init.sql                       — schema (16 tables)
--   2. 0002_seed_reference.sql             — 59 reference rows
--   3. 0003_seed_phase11.sql               — 4 companies + 6 sequences
--   4. 0004_add_operations_reference.sql   — operations.reference
--   5. 0005_contracts_and_payment.sql      — contracts table
--   6. 0006_payments_and_cleanup.sql       — payments table + drops
--   7. 0007_invoicer_foundation.sql        — THIS FILE
--   8. 0008_seed_invoicer_data.sql         — UPDATE rows + product-id rename
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. companies — banking + multilingual + signing + invoice defaults
-- -----------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN bank_name TEXT;
ALTER TABLE companies ADD COLUMN bank_account TEXT;
ALTER TABLE companies ADD COLUMN swift TEXT;
ALTER TABLE companies ADD COLUMN iban TEXT;
ALTER TABLE companies ADD COLUMN bank_address TEXT;

ALTER TABLE companies ADD COLUMN legal_name_ru TEXT;
ALTER TABLE companies ADD COLUMN legal_name_local TEXT;       -- Arabic for DEI, Vietnamese for DEASEAN, etc.
ALTER TABLE companies ADD COLUMN kpp TEXT;                    -- Russian КПП
ALTER TABLE companies ADD COLUMN ogrn TEXT;                   -- Russian ОГРН
ALTER TABLE companies ADD COLUMN bank_name_en TEXT;           -- English transliteration of bank_name
ALTER TABLE companies ADD COLUMN bik TEXT;                    -- Russian БИК
ALTER TABLE companies ADD COLUMN correspondent_account TEXT;  -- корр. счёт

ALTER TABLE companies ADD COLUMN last_verified INTEGER;
ALTER TABLE companies ADD COLUMN signing_authority_name TEXT;
ALTER TABLE companies ADD COLUMN signing_authority_title_en TEXT;
ALTER TABLE companies ADD COLUMN signing_authority_title_ru TEXT;

ALTER TABLE companies ADD COLUMN default_invoice_language TEXT
  CHECK (default_invoice_language IN ('EN', 'RU', 'BILINGUAL') OR default_invoice_language IS NULL);
ALTER TABLE companies ADD COLUMN preferred_incoterms_domestic TEXT;
ALTER TABLE companies ADD COLUMN preferred_incoterms_international TEXT;

-- -----------------------------------------------------------------------------
-- 2. company_bank_accounts (NEW)
-- -----------------------------------------------------------------------------
CREATE TABLE company_bank_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  account_purpose TEXT NOT NULL
    CHECK (account_purpose IN ('primary', 'rub', 'cny_usd', 'usd', 'eur', 'reserved_tax')),
  account_number TEXT NOT NULL,
  currency TEXT NOT NULL,
  notes TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
CREATE INDEX idx_cba_company ON company_bank_accounts(company_id);
CREATE INDEX idx_cba_purpose ON company_bank_accounts(account_purpose);

-- -----------------------------------------------------------------------------
-- 3. products — packaging dims, per-unit weight, country of origin,
--    multilingual descriptions, hs_code.
-- -----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN hs_code TEXT;
ALTER TABLE products ADD COLUMN ctn_qty INTEGER;
ALTER TABLE products ADD COLUMN ctn_weight_gross_kg REAL;
ALTER TABLE products ADD COLUMN ctn_dim_l_cm REAL;
ALTER TABLE products ADD COLUMN ctn_dim_w_cm REAL;
ALTER TABLE products ADD COLUMN ctn_dim_h_cm REAL;
ALTER TABLE products ADD COLUMN unit_net_weight_g REAL;
ALTER TABLE products ADD COLUMN country_of_origin TEXT;
ALTER TABLE products ADD COLUMN description_ru TEXT;
ALTER TABLE products ADD COLUMN description_en TEXT;
ALTER TABLE products ADD COLUMN description_cn TEXT;

-- -----------------------------------------------------------------------------
-- 4. manufacturers — multilingual identity + dual-route flag + last_verified
-- -----------------------------------------------------------------------------
ALTER TABLE manufacturers ADD COLUMN has_dual_route_banking INTEGER NOT NULL DEFAULT 0
  CHECK (has_dual_route_banking IN (0, 1));
ALTER TABLE manufacturers ADD COLUMN last_verified INTEGER;
ALTER TABLE manufacturers ADD COLUMN legal_name_en TEXT;
ALTER TABLE manufacturers ADD COLUMN legal_name_ru TEXT;
ALTER TABLE manufacturers ADD COLUMN legal_name_cn TEXT;
ALTER TABLE manufacturers ADD COLUMN registered_address_en TEXT;
ALTER TABLE manufacturers ADD COLUMN registered_address_ru TEXT;
ALTER TABLE manufacturers ADD COLUMN tax_id TEXT;             -- Chinese USCC

-- -----------------------------------------------------------------------------
-- 5. manufacturer_bank_routes (NEW)
-- -----------------------------------------------------------------------------
CREATE TABLE manufacturer_bank_routes (
  id TEXT PRIMARY KEY,
  manufacturer_id TEXT NOT NULL,
  route_code TEXT NOT NULL CHECK (route_code IN ('A', 'B', 'default')),
  payer_jurisdiction_filter TEXT,  -- 'RU,CIS' for Route A, 'INTERNATIONAL' for Route B, NULL for default
  bank_name TEXT NOT NULL,
  bank_address TEXT,
  account_number TEXT,
  iban TEXT,
  swift TEXT NOT NULL,
  account_holder TEXT NOT NULL,
  currency TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE CASCADE
);
CREATE INDEX idx_mbr_manufacturer ON manufacturer_bank_routes(manufacturer_id);

-- -----------------------------------------------------------------------------
-- 6. partners — local-language identity + RU tax fields + payment defaults
-- -----------------------------------------------------------------------------
ALTER TABLE partners ADD COLUMN legal_name_local TEXT;
ALTER TABLE partners ADD COLUMN registered_address_local TEXT;
ALTER TABLE partners ADD COLUMN kpp TEXT;
ALTER TABLE partners ADD COLUMN inn TEXT;
ALTER TABLE partners ADD COLUMN ogrn TEXT;
ALTER TABLE partners ADD COLUMN payment_terms TEXT;
ALTER TABLE partners ADD COLUMN preferred_incoterms TEXT;
ALTER TABLE partners ADD COLUMN preferred_invoice_language TEXT
  CHECK (preferred_invoice_language IN ('EN', 'RU', 'BILINGUAL') OR preferred_invoice_language IS NULL);
ALTER TABLE partners ADD COLUMN last_verified INTEGER;

-- -----------------------------------------------------------------------------
-- 7. contracts — УНК + invoice_language
-- -----------------------------------------------------------------------------
ALTER TABLE contracts ADD COLUMN unk_reference TEXT;
ALTER TABLE contracts ADD COLUMN unk_valid_until INTEGER;
ALTER TABLE contracts ADD COLUMN invoice_language TEXT
  CHECK (invoice_language IN ('EN', 'RU', 'BILINGUAL') OR invoice_language IS NULL);

-- -----------------------------------------------------------------------------
-- 8. operations — default_document_language
--    (final language at issue time = invoicer engine output, see
--    api/src/skills/invoicer.ts in a follow-up PR.)
-- -----------------------------------------------------------------------------
ALTER TABLE operations ADD COLUMN default_document_language TEXT
  CHECK (default_document_language IN ('EN', 'RU', 'BILINGUAL') OR default_document_language IS NULL);

-- =============================================================================
-- END OF MIGRATION 0007
-- =============================================================================
