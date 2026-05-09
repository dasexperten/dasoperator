-- =============================================================================
-- Migration 0006 — Payments table + cleanup legacy paid columns
-- =============================================================================
-- Q6 = A: separate payments table, NULL operation_id = advance
-- Q12 = A: contract_id NOT NULL (every payment scoped to contract)
-- Q13 = A: drop operations.payment_status + paid_amount + paid (replaced by
--          aggregating payments table)
--
-- Pre-flight (verified via D1 REST API):
--   operations  rows = 0
--   line_items  rows = 0
--   payments    table does not exist
-- → drops are safe, no data loss
-- =============================================================================

-- 1. Payments table
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  payment_date INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('advance','final','refund','partial')),
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_payments_partner ON payments(partner_id);
CREATE INDEX idx_payments_contract ON payments(contract_id);
CREATE INDEX idx_payments_operation ON payments(operation_id);
CREATE INDEX idx_payments_date ON payments(payment_date);

-- 2. Drop legacy columns from operations (replaced by payments aggregation)
-- Cloudflare D1 supports DROP COLUMN.
ALTER TABLE operations DROP COLUMN payment_status;
ALTER TABLE operations DROP COLUMN paid_amount;
ALTER TABLE operations DROP COLUMN paid;

-- =============================================================================
-- END OF MIGRATION 0006
-- =============================================================================
