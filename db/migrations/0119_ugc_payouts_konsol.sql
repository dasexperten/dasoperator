-- 0119 — UGC payouts through the Konsol Payment Service API (Owner 2026-10-14:
-- «Мина, запускай выплаты через API, тест на 1 рубль»).
--
-- ugc_payouts gains the Konsol ids and an execute lock: one Konsol payment per
-- row, ever (unique konsol_payment_id; execute_claim held while Konsol is asked).
-- The SBP bank id (12-digit NSPK id, not a secret) sits on the payout row.
--
-- The full SBP phone and the recipient name live ONLY in ugc_payout_requisites,
-- which the UGC listing never joins; ugc_payouts keeps the masked phone.
--
-- Additive only. Rollback:
--   DROP TABLE ugc_payout_requisites;
--   DROP INDEX idx_ugc_payouts_konsol_payment;
--   (the new ugc_payouts columns are nullable and unused by older code; leave
--    them, or ALTER TABLE ugc_payouts DROP COLUMN <name> for each.)

ALTER TABLE ugc_payouts ADD COLUMN fps_bank_member_id TEXT;
ALTER TABLE ugc_payouts ADD COLUMN konsol_contractor_id TEXT;
ALTER TABLE ugc_payouts ADD COLUMN konsol_payment_id TEXT;
ALTER TABLE ugc_payouts ADD COLUMN konsol_status TEXT;
ALTER TABLE ugc_payouts ADD COLUMN konsol_error TEXT;
ALTER TABLE ugc_payouts ADD COLUMN execute_claim TEXT;
ALTER TABLE ugc_payouts ADD COLUMN execute_claimed_at TEXT;
ALTER TABLE ugc_payouts ADD COLUMN paid_notice_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ugc_payouts_konsol_payment
  ON ugc_payouts(konsol_payment_id) WHERE konsol_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ugc_payout_requisites (
  payout_id         TEXT PRIMARY KEY REFERENCES ugc_payouts(id),
  fps_mobile_phone  TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  patronymic        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
