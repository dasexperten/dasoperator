-- =============================================================================
-- 0036_backfill_operation_track_for_service_partners.sql
-- =============================================================================
-- Retroactive: flip operation_track to 'service' for all historical operations
-- where the partner is already tagged with partner_subtype (service_provider /
-- logistics / agency). Without this, all pre-0034 rows stay on 'goods' and the
-- new ServiceStatusBar never renders for them.
--
-- Already applied to prod das_erp_dev on 2026-05-13 via D1 REST. 108 rows
-- affected. Distribution after: 237 goods / 108 service.
--
-- Idempotent: WHERE operation_track = 'goods' guards against double-flips
-- (and against accidentally reverting any operation manually set to 'service'
-- by the UI in the meantime).
-- =============================================================================

UPDATE operations
SET operation_track = 'service'
WHERE id IN (
  SELECT o.id
  FROM operations o
  JOIN partners p ON p.id = o.partner_id
  WHERE p.partner_subtype IS NOT NULL
    AND o.operation_track = 'goods'
    AND o.deleted_at IS NULL
);

-- =============================================================================
-- End of 0036_backfill_operation_track_for_service_partners.sql
-- =============================================================================
