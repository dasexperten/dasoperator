-- =============================================================================
-- Migration 0004 — Add operations.reference column
-- =============================================================================
-- Cleanup of Phase 2.0c-2 architectural compromise. Operation reference numbers
-- (DEE-001, DEI-005, etc) were temporarily stored in order_doc_ref because no
-- dedicated column existed. This migration adds reference as a first-class
-- column and backfills existing data.
--
-- order_doc_ref is freed for its legitimate purpose: customer purchase order
-- numbers and external reference identifiers from counterparties.
--
-- Application order:
--   1. 0001_init.sql              — schema
--   2. 0002_seed_reference.sql    — 59 reference rows
--   3. 0003_seed_phase11.sql      — companies + sequences
--   4. 0004_add_operations_reference.sql — THIS FILE
-- =============================================================================

-- Add the reference column (nullable initially for backfill)
ALTER TABLE operations ADD COLUMN reference TEXT;

-- Backfill: copy existing order_doc_ref values to reference for any
-- operations created during Phase 2.0c-2 transition period
UPDATE operations
SET reference = order_doc_ref
WHERE order_doc_ref IS NOT NULL
  AND reference IS NULL;

-- Clear order_doc_ref for backfilled rows so it is available for its
-- legitimate use (customer PO numbers, counterparty refs)
UPDATE operations
SET order_doc_ref = NULL
WHERE reference = order_doc_ref;

-- Index for fast reference lookup (e.g. "find operation DEE-001")
CREATE INDEX IF NOT EXISTS idx_operations_reference ON operations(reference);

-- =============================================================================
-- END OF MIGRATION 0004
-- =============================================================================
