-- =============================================================================
-- Migration 0005 — Contracts table + Payment markdown enhancements
-- =============================================================================
-- Two related schema additions:
--
-- 1. New contracts table — partner can have multiple contracts with different
--    entities (DEE/DEI/DASEAN/DEC) and different currencies. Currency lives
--    on the contract, not the partner.
--
-- 2. Payment markdown — paid (0/1 boolean) is replaced by payment_status
--    (paid/unpaid/partly) + paid_amount. Old paid column kept for backward
--    compat, deprecated; will drop in 0006 cleanup.
--
-- Backfill:
--   - All partners with non-NULL contract_no AND linked_entity_id AND currency
--     get a contracts row (6 total — VIP SALES included since its contract_no
--     is valid 'DEI-VS-2024-03', only its bank fields are MISSING)
--   - Existing operations.paid → kept as-is for now (no operations exist yet)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Contracts table
-- -----------------------------------------------------------------------------
CREATE TABLE contracts (
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
  deleted_at INTEGER
);

CREATE INDEX idx_contracts_partner ON contracts(partner_id);
CREATE INDEX idx_contracts_company ON contracts(our_company_id);
CREATE INDEX idx_contracts_status ON contracts(status);

-- -----------------------------------------------------------------------------
-- 2. Operations.contract_id — link operation to its contract
-- -----------------------------------------------------------------------------
ALTER TABLE operations ADD COLUMN contract_id TEXT REFERENCES contracts(id);
CREATE INDEX idx_operations_contract ON operations(contract_id);

-- -----------------------------------------------------------------------------
-- 3. Payment markdown enhancement
-- -----------------------------------------------------------------------------
ALTER TABLE operations ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('paid','unpaid','partly'));

ALTER TABLE operations ADD COLUMN paid_amount INTEGER NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- 4. Backfill contracts from existing partners
-- (Run separately via REST API alongside this PR — applied 2026-05-04)
-- -----------------------------------------------------------------------------
-- INSERT INTO contracts (id, contract_no, partner_id, our_company_id, currency,
--                        signed_date, status, created_at, updated_at)
-- SELECT
--   'ctr_' || lower(replace(replace(p.contract_no, '-', '_'), '/', '_')),
--   p.contract_no, p.id, p.linked_entity_id, p.currency,
--   p.contract_date, 'active', <now>, <now>
-- FROM partners p
-- WHERE p.contract_no IS NOT NULL
--   AND p.contract_no != 'MISSING'
--   AND p.linked_entity_id IS NOT NULL
--   AND p.currency IS NOT NULL
--   AND p.deleted_at IS NULL;

-- =============================================================================
-- END OF MIGRATION 0005
-- =============================================================================
