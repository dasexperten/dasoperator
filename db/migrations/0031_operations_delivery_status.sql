-- =============================================================================
-- 0031_operations_delivery_status.sql
-- Add a third dimension of operation state: physical delivery / fulfilment.
--
-- Existing dimensions:
--   operations.status       — document lifecycle (issued / cancelled)
--   payments                — money movement (incoming / outgoing)
--
-- New dimension:
--   operations.delivery_status — has the underlying service / goods
--                                 actually been received?
--     pending    — invoice issued and possibly paid, but service/goods
--                  not yet delivered (e.g. prepaid certification work)
--     delivered  — received in full. The default for all historical rows.
--     disputed   — received but contested (wrong, damaged, short)
--     refunded   — money returned, nothing was ultimately received
--
-- This is what makes the UI show a checkmark (delivered) or a clock
-- (pending) next to an operation independent of its payment state.
-- =============================================================================

ALTER TABLE operations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'delivered'
  CHECK (delivery_status IN ('pending','delivered','disputed','refunded'));

-- Existing data: legacy operations default to 'delivered' because the
-- absence of a tracking flag historically meant "done".
-- Operationally, set known-pending operations manually after deploy.

-- Example: Уралстандартизация certification — paid but service not yet
-- rendered. (Run separately via ops.)
-- UPDATE operations SET delivery_status='pending'
--   WHERE partner_id='uralstandart' AND status='issued';
