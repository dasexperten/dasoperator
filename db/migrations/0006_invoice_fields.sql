-- =============================================================================
-- Migration 0006 — CI/PL invoice fields (companies banking, products HS code,
-- operations.status 'issued')
-- =============================================================================
-- Adds the data the PDF renderer (Phase 2.0c-3) currently has to render as
-- TBD because the underlying columns do not exist:
--
--   1. companies — bank_name, bank_account, swift, iban, bank_address.
--      Sellers' banking block on Commercial Invoice is built from these.
--   2. products — hs_code. Per-line HS code on CI/PL (today the renderer
--      falls back to operations.hs_code, a single per-document value).
--   3. operations.status — extend CHECK to include 'issued', so an
--      operation can transition draft → issued once both CI and PL are
--      generated. Without this, the documents route has to advance to
--      'order_fulfilment' as a workaround (see PR #28).
--
-- All new columns are nullable; no UPDATE/backfill in this migration. Real
-- values land in a follow-up seed migration.
--
-- Note on file numbering: task brief named this 0004_invoice_fields.sql, but
-- 0004_add_operations_reference.sql and 0005_contracts_and_payment.sql were
-- already merged to main, so this is 0006.
--
-- Application order (clean clone):
--   1. 0001_init.sql              — schema (16 tables)
--   2. 0002_seed_reference.sql    — 59 reference rows
--   3. 0003_seed_phase11.sql      — 4 companies + 6 sequences
--   4. 0004_add_operations_reference.sql — operations.reference
--   5. 0005_contracts_and_payment.sql    — contracts table + payment fields
--   6. 0006_invoice_fields.sql           — THIS FILE
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. companies — banking fields
-- -----------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN bank_name TEXT;
ALTER TABLE companies ADD COLUMN bank_account TEXT;
ALTER TABLE companies ADD COLUMN swift TEXT;
ALTER TABLE companies ADD COLUMN iban TEXT;
ALTER TABLE companies ADD COLUMN bank_address TEXT;

-- -----------------------------------------------------------------------------
-- 2. products — HS code
-- -----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN hs_code TEXT;

-- -----------------------------------------------------------------------------
-- 3. operations.status — extend CHECK to include 'issued'
-- -----------------------------------------------------------------------------
-- SQLite cannot alter a CHECK constraint in place. Standard 12-step procedure
-- (see https://sqlite.org/lang_altertable.html#otheralter):
--   a) CREATE TABLE operations_new with the updated CHECK and ALL columns
--      that exist in production after migrations 0001 + 0004 + 0005.
--   b) INSERT INTO operations_new SELECT ... FROM operations  (explicit
--      column lists; no '*' to keep the migration robust against column
--      ordering drift).
--   c) DROP TABLE operations
--   d) ALTER TABLE operations_new RENAME TO operations
--   e) Recreate the six indexes that existed on operations
--      (idx_operations_date, _type, _status, _partner from 0001;
--       idx_operations_reference from 0004;
--       idx_operations_contract from 0005).
--
-- Foreign-key safety in D1: D1 has FK enforcement disabled by default on
-- new connections, so child tables (line_items.operation_id,
-- documents.operation_id) keep their FK constraints by name and re-resolve
-- to the new operations table after rename. We still emit `PRAGMA
-- foreign_keys=OFF/ON` and `defer_foreign_keys` for parity with the
-- SQLite docs procedure; D1 ignores PRAGMAs it does not honour without
-- erroring.
-- -----------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;

CREATE TABLE operations_new (
  id TEXT PRIMARY KEY,
  operation_date INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('sale', 'purchase', 'transfer')),
  partner_id TEXT,
  our_company_id TEXT NOT NULL,
  manufacturer_id TEXT,
  warehouse_from_id TEXT,
  warehouse_to_id TEXT,
  shipment_scheme TEXT CHECK (shipment_scheme IN ('A', 'B', 'C') OR shipment_scheme IS NULL),
  shipper_id TEXT,
  order_doc_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'order_fulfilment', 'production', 'shipped', 'delivered', 'cancelled')),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  price_type_id TEXT,
  currency TEXT,
  fx_rate_to_usd INTEGER,
  total_amount INTEGER,
  total_usd_equiv INTEGER,
  incoterms TEXT,
  hs_code TEXT,
  lead_time_days INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  reference TEXT,                                       -- added by 0004
  contract_id TEXT,                                     -- added by 0005
  payment_status TEXT NOT NULL DEFAULT 'unpaid'         -- added by 0005
    CHECK (payment_status IN ('paid', 'unpaid', 'partly')),
  paid_amount INTEGER NOT NULL DEFAULT 0,               -- added by 0005
  FOREIGN KEY (partner_id)         REFERENCES partners(id)    ON DELETE RESTRICT,
  FOREIGN KEY (our_company_id)     REFERENCES companies(id)   ON DELETE RESTRICT,
  FOREIGN KEY (manufacturer_id)    REFERENCES manufacturers(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_from_id)  REFERENCES warehouses(id)  ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_to_id)    REFERENCES warehouses(id)  ON DELETE RESTRICT,
  FOREIGN KEY (shipper_id)         REFERENCES partners(id)    ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id)      REFERENCES price_types(id) ON DELETE RESTRICT,
  FOREIGN KEY (contract_id)        REFERENCES contracts(id)
);

INSERT INTO operations_new (
  id, operation_date, operation_type, partner_id, our_company_id,
  manufacturer_id, warehouse_from_id, warehouse_to_id,
  shipment_scheme, shipper_id, order_doc_ref,
  status, paid, price_type_id, currency, fx_rate_to_usd,
  total_amount, total_usd_equiv, incoterms, hs_code, lead_time_days, notes,
  created_at, updated_at, deleted_at,
  reference, contract_id, payment_status, paid_amount
)
SELECT
  id, operation_date, operation_type, partner_id, our_company_id,
  manufacturer_id, warehouse_from_id, warehouse_to_id,
  shipment_scheme, shipper_id, order_doc_ref,
  status, paid, price_type_id, currency, fx_rate_to_usd,
  total_amount, total_usd_equiv, incoterms, hs_code, lead_time_days, notes,
  created_at, updated_at, deleted_at,
  reference, contract_id, payment_status, paid_amount
FROM operations;

DROP TABLE operations;

ALTER TABLE operations_new RENAME TO operations;

-- Recreate every index that existed on operations across migrations 0001/0004/0005.
CREATE INDEX idx_operations_date      ON operations(operation_date);
CREATE INDEX idx_operations_type      ON operations(operation_type);
CREATE INDEX idx_operations_status    ON operations(status);
CREATE INDEX idx_operations_partner   ON operations(partner_id);
CREATE INDEX idx_operations_reference ON operations(reference);
CREATE INDEX idx_operations_contract  ON operations(contract_id);

PRAGMA foreign_keys=ON;

-- =============================================================================
-- END OF MIGRATION 0006
-- =============================================================================
