-- =============================================================================
-- Migration 0010 — VAT rate on contracts and operations
-- =============================================================================
-- Adds vat_rate (integer percent: 0, 5, or 20) to:
--   1. contracts — source of truth, set once per contract
--   2. operations — snapshot copied at operation creation time
--
-- Decision recap (from chat 2026-05-05):
--   - Q1: Field is integer percent, not enum (simpler arithmetic)
--   - Q2: Snapshot in operations (old operations don't recompute if contract changes)
--   - Q3: When vat_rate = 0, UI hides VAT row entirely (no "VAT — exempt" label)
--   - All 6 existing contracts get vat_rate = 0 (none of current partners are VAT-bearing)
--   - Russian B2B clients selling under DEE will eventually use vat_rate = 5
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add vat_rate to contracts
-- -----------------------------------------------------------------------------
ALTER TABLE contracts ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 0
  CHECK (vat_rate IN (0, 5, 20));

-- -----------------------------------------------------------------------------
-- 2. Add vat_rate to operations (snapshot)
-- -----------------------------------------------------------------------------
ALTER TABLE operations ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 0
  CHECK (vat_rate IN (0, 5, 20));

-- -----------------------------------------------------------------------------
-- 3. Backfill existing operations from their contract
--    (current 5 operations all link to contracts with vat_rate=0, so it's a no-op
--     but kept here for completeness / audit trail)
-- -----------------------------------------------------------------------------
UPDATE operations
SET vat_rate = (
  SELECT vat_rate FROM contracts WHERE contracts.id = operations.contract_id
)
WHERE contract_id IS NOT NULL;
