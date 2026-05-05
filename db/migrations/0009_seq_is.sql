-- =============================================================================
-- Migration 0009 — seq_is sequence row.
-- =============================================================================
-- The invoicer engine (Phase 2.0c-5) issues IS-V1 / IS-V2 documents and asks
-- for `seq_is` from sequences. The original Phase 1.1 seed (0003) only set up
-- seq_dee/_dei/_dasean/_dec + seq_ci/_pl. This adds the missing IS counter so
-- POST /api/documents/issue can produce IS references.
--
-- Format: IS-YYYYMM-0001 (matches CI/PL convention; padding=4).
-- =============================================================================

INSERT INTO sequences (id, description, next_number, padding, format_example, updated_at)
VALUES ('seq_is', 'Invoice Specification global counter', 1, 4, 'IS-202605-0001', strftime('%s','now'));

-- =============================================================================
-- END OF MIGRATION 0009
-- =============================================================================
