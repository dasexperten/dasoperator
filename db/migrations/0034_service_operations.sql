-- =============================================================================
-- 0034_service_operations.sql
-- =============================================================================
-- Adds a second operation track for service-only counterparties (auditors,
-- logistics, consulting, agencies). Service operations skip the goods
-- progress bar (CI · PL · IS · RFQ · Production · Shipped · Delivered) and
-- show two binary status chips instead: Service provided / Paid.
--
-- DESIGN NOTE — no new status columns:
--   * "Service provided" reuses `operations.delivery_status` from 0031:
--       delivered → service provided ACTIVE
--       pending/disputed/refunded → service provided INACTIVE
--   * "Paid" is computed at read time as
--       SUM(payments.amount where direction matches) >= operations.total_amount
--     No denormalised column, no triggers. Payments are already in their own
--     table (0006_payments_and_cleanup).
--
-- Only two additive columns are introduced here, both with safe defaults.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. operations.operation_track
-- ----------------------------------------------------------------------------
-- 'goods'   — existing flow (default for all historical rows)
-- 'service' — service flow (Acceptance instead of PL/UPD/TN, no Production)
-- ----------------------------------------------------------------------------

ALTER TABLE operations ADD COLUMN operation_track TEXT NOT NULL DEFAULT 'goods'
  CHECK (operation_track IN ('goods','service'));

CREATE INDEX IF NOT EXISTS idx_operations_track ON operations(operation_track);


-- ----------------------------------------------------------------------------
-- 2. partners.partner_subtype
-- ----------------------------------------------------------------------------
-- The existing `partners.partner_type` column already takes values
-- buyer / supplier / shipper and we MUST NOT widen it — too many indexes,
-- filters and routing rules depend on those exact tokens.
--
-- Instead we add a nullable subtype that the new-operation form reads to
-- auto-suggest the service track. Goods suppliers leave it NULL.
--
-- Examples:
--   Accuvat (UAE auditors)         → partner_type=supplier, subtype=service_provider
--   Inter-Freight (forwarder)      → partner_type=shipper,  subtype=logistics
--   marketing agency               → partner_type=supplier, subtype=agency
-- ----------------------------------------------------------------------------

ALTER TABLE partners ADD COLUMN partner_subtype TEXT
  CHECK (partner_subtype IN ('service_provider','logistics','agency'));

CREATE INDEX IF NOT EXISTS idx_partners_subtype ON partners(partner_subtype);


-- ----------------------------------------------------------------------------
-- 3. Backfill — known service-only counterparties
-- ----------------------------------------------------------------------------
-- Safe to run multiple times: LIKE patterns are narrow and only update rows
-- where subtype is still NULL. Add more rows here as new service partners
-- are onboarded, or use the UI to set the subtype manually.
-- ----------------------------------------------------------------------------

UPDATE partners
SET partner_subtype = 'service_provider'
WHERE partner_subtype IS NULL
  AND (
    LOWER(trade_name) LIKE '%accuvat%'
    OR LOWER(trade_name) LIKE '%консоль.про%'
    OR LOWER(trade_name) LIKE '%konsol.pro%'
    OR LOWER(COALESCE(legal_name, '')) LIKE '%consulting%'
    OR LOWER(COALESCE(legal_name, '')) LIKE '%audit%'
  );

UPDATE partners
SET partner_subtype = 'logistics'
WHERE partner_subtype IS NULL
  AND (
    partner_type = 'shipper'
    OR LOWER(trade_name) LIKE '%inter-freight%'
    OR LOWER(trade_name) LIKE '%интер-фрейт%'
  );


-- =============================================================================
-- End of 0034_service_operations.sql
-- Run with:
--   wrangler d1 execute das_erp_dev --remote \
--     --file=db/migrations/0034_service_operations.sql
-- =============================================================================
