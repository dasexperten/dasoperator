-- =============================================================================
-- 0037_backfill_partner_subtype_from_kind.sql
-- =============================================================================
-- Catch-up to 0035/0036. The `partners.kind` column (Phase 8.0) already
-- classifies counterparties into buyer/manufacturer/service_provider/shipper/
-- 3pl/other — a much more accurate signal than the trade_name patterns used
-- in 0035. This migration uses `kind` as source of truth for any partner
-- still missing partner_subtype, and then re-flips their operations.
--
-- Already applied to prod das_erp_dev on 2026-05-13. Effect on prod:
--   • +28 partners → service_provider (kind already = service_provider)
--   • +6  partners → logistics       (kind in (3pl, shipper))
--   • +180 operations flipped to service track
--
-- Final live distribution: 288 service / 57 goods operations.
--
-- Idempotent: each UPDATE has `WHERE partner_subtype IS NULL` /
-- `WHERE operation_track = 'goods'` guards.
-- =============================================================================

UPDATE partners
SET partner_subtype = 'service_provider'
WHERE partner_subtype IS NULL
  AND kind = 'service_provider';

UPDATE partners
SET partner_subtype = 'logistics'
WHERE partner_subtype IS NULL
  AND kind IN ('3pl', 'shipper');

UPDATE operations
SET operation_track = 'service'
WHERE operation_track = 'goods'
  AND deleted_at IS NULL
  AND partner_id IN (
    SELECT id FROM partners WHERE partner_subtype IS NOT NULL
  );

-- =============================================================================
-- End of 0037_backfill_partner_subtype_from_kind.sql
-- =============================================================================
