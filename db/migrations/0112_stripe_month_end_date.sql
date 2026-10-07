-- 0112_stripe_month_end_date.sql — Owner 2026-10-07
-- STRIPE-YYYYMM monthly lines move from the 1st to the LAST day of their month,
-- the same as TBANK-YYYYMM; the builders now write that date themselves.
--
-- Rollback:
--   UPDATE operations
--      SET operation_date = CAST(strftime('%s', date(operation_date, 'unixepoch', 'start of month')) AS INTEGER)
--    WHERE reference LIKE 'STRIPE-%' AND deleted_at IS NULL;

UPDATE operations
   SET operation_date = CAST(strftime('%s', date(operation_date, 'unixepoch', 'start of month', '+1 month', '-1 day')) AS INTEGER),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE reference LIKE 'STRIPE-%' AND deleted_at IS NULL;
