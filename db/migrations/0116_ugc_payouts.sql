-- 0116 — UGC barter payouts (Owner 2026-10-14, via Diana Helios).
--
-- One row per refund payout to a creator: we refund the cart price, the
-- creator buys on WB/Ozon and posts a review video. Flow outside the ERP:
-- Google sheet «Оплаты Консоль» → Konsol xlsx → Telegram → bank CSV
-- (oplata@tbank.ru). The ERP keeps the status, never the payment details.
--
-- Not a payment vault (same rule as 0098): no raw phone numbers, no card or
-- account numbers. phone_masked holds at most a masked form like
-- +79XX*****09, enough to match a line of the bank CSV.
--
-- Owner limit: at most 999 ₽ per creator per payout per day. The CHECK below
-- holds the single-payout ceiling in the database itself; the per-day sum is
-- enforced by the API (api/src/lib/ugc-payouts.mjs).
--
-- Additive only. Rollback: DROP TABLE ugc_payouts (no other table refers to it).

CREATE TABLE IF NOT EXISTS ugc_payouts (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL REFERENCES ugc_creators(id),
  creator_platform_id TEXT REFERENCES ugc_creator_platforms(id),
  platform            TEXT,
  handle              TEXT,
  amount_minor        INTEGER NOT NULL
    CHECK (amount_minor > 0 AND amount_minor <= 99900),
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
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ugc_payouts_creator ON ugc_payouts(creator_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_payouts_status ON ugc_payouts(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_payouts_day ON ugc_payouts(creator_id, payout_date);
