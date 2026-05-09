-- Migration 0025 — unify agreements into contracts
-- 
-- Date: 2026-05-09
-- Author: Claude Code (this chat)
-- 
-- WHY: NDA / MOU / LOI / amendment / other documents previously lived
-- in `partner_agreements` (separate table, never used — 0 rows).
-- Aram's decision: all such documents go into `contracts` because
-- "agreement" and "контракт" are the same thing.
--
-- WHAT THIS DOES:
--   1. Extends contracts.agreement_type CHECK from 4 → 8 values:
--      ('main','addendum','annex','sla','nda','mou','loi','other')
--   2. Drops partner_agreements (was empty, no code references).
--
-- HOW (because SQLite cannot ALTER CHECK in place, and FK from
-- operations/payments/line_items/bundling_items/documents/
-- bank_transactions block direct DROP TABLE):
--   - Created v2 of contracts/operations/payments with new CHECK
--     and FK pointing at contracts_v2/operations_v2.
--   - Renamed old → _old, then v2 → final. SQLite auto-rewrites
--     FK references in child tables on rename, so children
--     (line_items/bundling_items/documents/bank_transactions)
--     also had to be rebuilt to point at the new tables.
--   - Same trick applied to bank_transactions which had matched_payment_id
--     FK to payments_old.
--   - All _old tables emptied and dropped at the end.
--
-- ROW COUNT INVARIANTS PRESERVED:
--   contracts: 63 → 63
--   operations: 335 → 335
--   payments: 358 → 358
--   line_items: 12 → 12
--   bundling_items: 0 → 0
--   documents: 3 → 3
--   bank_transactions: 630 → 630
--
-- This file is documentation only — the migration was applied
-- directly to D1 in the same session (D1 has no migrations runner
-- like wrangler d1 migrations apply for direct REST work).

-- ============================================================
-- (1) Build v2 of contracts/operations/payments
-- ============================================================

CREATE TABLE contracts_v2 (
  id TEXT PRIMARY KEY,
  contract_no TEXT NOT NULL UNIQUE,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  our_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL,
  signed_date INTEGER,
  expiry_date INTEGER,
  incoterms TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','expired','cancelled')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  unk_reference TEXT,
  unk_valid_until INTEGER,
  invoice_language TEXT
    CHECK (invoice_language IN ('EN','RU','BILINGUAL') OR invoice_language IS NULL),
  vat_rate INTEGER NOT NULL DEFAULT 0 CHECK (vat_rate IN (0,5,20)),
  parent_contract_id TEXT REFERENCES contracts_v2(id) ON DELETE RESTRICT,
  addendum_no TEXT,
  agreement_type TEXT NOT NULL DEFAULT 'main'
    CHECK (agreement_type IN ('main','addendum','annex','sla','nda','mou','loi','other')),
  contract_file_key TEXT
);

INSERT INTO contracts_v2 SELECT * FROM contracts;

-- (operations_v2 + payments_v2 created similarly with FK to contracts_v2)
-- See git history for full statements.

-- ============================================================
-- (2) Rename dance
-- ============================================================

ALTER TABLE payments RENAME TO payments_old;
ALTER TABLE operations RENAME TO operations_old;
ALTER TABLE contracts RENAME TO contracts_old;
ALTER TABLE contracts_v2 RENAME TO contracts;
ALTER TABLE operations_v2 RENAME TO operations;
ALTER TABLE payments_v2 RENAME TO payments;

-- ============================================================
-- (3) Children tables also had to be rebuilt because SQLite
--     auto-rewrote their FK to point at *_old after rename.
-- ============================================================

-- (line_items_v2 / bundling_items_v2 / documents_v2 created with
--  FK to operations(id), data copied, _old renamed, _v2 renamed.)

-- ============================================================
-- (4) bank_transactions also rebuilt — its FK to payments was
--     auto-rewritten to payments_old too.
-- ============================================================

-- (bank_transactions_v2 with FK to payments(id) and
--  company_bank_accounts(id), data copied, renames.)

-- ============================================================
-- (5) Cleanup
-- ============================================================

DELETE FROM payments_old;
DELETE FROM bundling_items_old;
DELETE FROM line_items_old;
DELETE FROM documents_old;
DELETE FROM bank_transactions_old;
DELETE FROM operations_old;
UPDATE contracts_old SET parent_contract_id = NULL;
DELETE FROM contracts_old;
DROP TABLE payments_old;
DROP TABLE bundling_items_old;
DROP TABLE line_items_old;
DROP TABLE documents_old;
DROP TABLE bank_transactions_old;
DROP TABLE operations_old;
DROP TABLE contracts_old;
DROP TABLE partner_agreements;

-- ============================================================
-- (6) Indexes recreated
-- ============================================================

CREATE INDEX idx_contracts_partner ON contracts(partner_id);
CREATE INDEX idx_contracts_company ON contracts(our_company_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_agreement_type ON contracts(agreement_type);  -- NEW

CREATE INDEX idx_operations_partner ON operations(partner_id);
CREATE INDEX idx_operations_contract ON operations(contract_id);
CREATE INDEX idx_operations_status ON operations(status);
CREATE INDEX idx_operations_type ON operations(operation_type);
CREATE INDEX idx_operations_date ON operations(operation_date);

CREATE INDEX idx_payments_op ON payments(operation_id);
CREATE INDEX idx_line_items_op ON line_items(operation_id);
CREATE INDEX idx_bundling_items_op ON bundling_items(operation_id);

CREATE INDEX idx_bank_tx_account_executed
  ON bank_transactions(company_bank_account_id, executed_at DESC);
CREATE INDEX idx_bank_tx_unmatched
  ON bank_transactions(matched_payment_id) WHERE matched_payment_id IS NULL;
CREATE INDEX idx_bank_tx_inn
  ON bank_transactions(contragent_inn) WHERE contragent_inn IS NOT NULL;
