-- =============================================================================
-- Migration 0049 — attachment lock signal
--
-- Adds sent_at to operation_attachments. When set, the attachment has been
-- sent outbound (emailed, faxed, shipped with cargo, etc.) and must NOT be
-- silently detached from the operation. UI shows the X disabled.
--
-- The other lock signal — operation.status IN ('shipped','delivered') —
-- needs no schema change; it's already in operations.status.
--
-- Cemented rule (2026-05-29):
--   Document is "locked" (X disabled, label = "Sent — locked") when EITHER
--   operation_attachments.sent_at IS NOT NULL
--   OR operations.status IN ('shipped','delivered').
-- =============================================================================

ALTER TABLE operation_attachments
  ADD COLUMN sent_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_oa_sent_at
  ON operation_attachments(sent_at)
  WHERE sent_at IS NOT NULL;
