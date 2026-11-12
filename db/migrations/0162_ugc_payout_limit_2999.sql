-- Owner 2026-11-12: one payout up to 2 999 ₽ (was 999 ₽). SQLite cannot change a
-- CHECK in place, so the table is rebuilt with the same columns, rows and indexes.
-- The requisites rows step aside first, so no foreign key is ever left dangling.
CREATE TABLE ugc_payouts_copy_0162 AS SELECT * FROM ugc_payouts;
CREATE TABLE ugc_payout_requisites_copy_0162 AS SELECT * FROM ugc_payout_requisites;
DELETE FROM ugc_payout_requisites;
DROP TABLE ugc_payouts;
CREATE TABLE ugc_payouts (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL REFERENCES ugc_creators(id),
  creator_platform_id TEXT REFERENCES ugc_creator_platforms(id),
  platform            TEXT,
  handle              TEXT,
  amount_minor        INTEGER NOT NULL
    CHECK (amount_minor > 0 AND amount_minor <= 299900),
  currency            TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  status              TEXT NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval', 'approved', 'sent', 'paid', 'failed')),
  payout_date         TEXT NOT NULL,
  marketplace         TEXT,
  phone_masked        TEXT,
  bank_ref            TEXT,
  note                TEXT,
  approved_at         TEXT,
  approved_by         TEXT,
  sent_at             TEXT,
  paid_at             TEXT,
  failed_at           TEXT,
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  fps_bank_member_id TEXT, konsol_contractor_id TEXT, konsol_payment_id TEXT, konsol_status TEXT, konsol_error TEXT, execute_claim TEXT, execute_claimed_at TEXT, paid_notice_at TEXT, product TEXT, notice_status TEXT, notice_error TEXT, notice_message_id TEXT, notice_at TEXT
);
INSERT INTO ugc_payouts SELECT * FROM ugc_payouts_copy_0162;
INSERT INTO ugc_payout_requisites SELECT * FROM ugc_payout_requisites_copy_0162;
DROP TABLE ugc_payouts_copy_0162;
DROP TABLE ugc_payout_requisites_copy_0162;
CREATE INDEX idx_ugc_payouts_creator ON ugc_payouts(creator_id, updated_at DESC);
CREATE INDEX idx_ugc_payouts_status ON ugc_payouts(status, updated_at DESC);
CREATE INDEX idx_ugc_payouts_day ON ugc_payouts(creator_id, payout_date);
CREATE UNIQUE INDEX idx_ugc_payouts_konsol_payment ON ugc_payouts(konsol_payment_id) WHERE konsol_payment_id IS NOT NULL;
