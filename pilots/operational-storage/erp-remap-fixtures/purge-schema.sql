PRAGMA foreign_keys=ON;
-- Source: db/migrations/0060_crm_website.sql statement 13

-- poller cursors and backfill bookmarks
CREATE TABLE IF NOT EXISTS crm_sync_state (
  key        TEXT PRIMARY KEY,                       -- e.g. 'stripe:last_created'
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 1
-- 0098 — UGC creator pipeline.
--
-- Public creator/profile metrics and operational collaboration state live in
-- separate tables. Raw payment details from legacy spreadsheets are
-- deliberately excluded: the broad UGC screen is not a payment vault.

CREATE TABLE IF NOT EXISTS ugc_creators (
  id               TEXT PRIMARY KEY,
  normalized_handle TEXT NOT NULL,
  display_name     TEXT,
  category         TEXT,
  audience_market  TEXT,
  audience_language TEXT,
  lifecycle_stage  TEXT NOT NULL DEFAULT 'found',
  priority         TEXT,
  owner            TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 2

CREATE TABLE IF NOT EXISTS ugc_creator_platforms (
  id                     TEXT PRIMARY KEY,
  creator_id             TEXT NOT NULL REFERENCES ugc_creators(id),
  platform               TEXT NOT NULL,
  handle                 TEXT NOT NULL,
  normalized_handle      TEXT NOT NULL,
  profile_url            TEXT,
  followers              INTEGER,
  engagement_rate        REAL,
  engagement_rate_method TEXT,
  avg_video_views        REAL,
  median_video_views     REAL,
  avg_comments           REAL,
  posting_cadence        REAL,
  commerce_clicks        INTEGER,
  commerce_orders        INTEGER,
  commerce_gmv_minor     INTEGER,
  commerce_currency      TEXT,
  metrics_as_of          TEXT,
  source                 TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(platform, normalized_handle)
);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 3

CREATE TABLE IF NOT EXISTS ugc_content (
  id                  TEXT PRIMARY KEY,
  creator_id          TEXT NOT NULL REFERENCES ugc_creators(id),
  creator_platform_id TEXT NOT NULL REFERENCES ugc_creator_platforms(id),
  content_url         TEXT,
  content_type        TEXT,
  published_at        TEXT,
  views               INTEGER,
  likes               INTEGER,
  comments            INTEGER,
  saves               INTEGER,
  shares              INTEGER,
  engagement_rate     REAL,
  product_codes       TEXT,
  usage_label         TEXT,
  source_rating       REAL,
  source_valid        TEXT,
  audio_label         TEXT,
  download_url        TEXT,
  source_workbook     TEXT,
  source_sheet        TEXT,
  source_row          INTEGER,
  imported_at         INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(source_workbook, source_sheet, source_row)
);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 4

CREATE TABLE IF NOT EXISTS ugc_collaborations (
  id                TEXT PRIMARY KEY,
  creator_id        TEXT NOT NULL REFERENCES ugc_creators(id),
  platform          TEXT,
  status            TEXT NOT NULL DEFAULT 'found',
  contact_channel   TEXT,
  invited_at        TEXT,
  accepted_at       TEXT,
  last_contact_at   TEXT,
  next_action       TEXT,
  next_action_at    TEXT,
  offer_type        TEXT,
  deliverables      TEXT,
  product_codes     TEXT,
  sample_status     TEXT,
  sample_sent_at    TEXT,
  content_due_at    TEXT,
  published_at      TEXT,
  rights_scope      TEXT,
  rights_expires_at TEXT,
  owner             TEXT,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 5

CREATE INDEX IF NOT EXISTS idx_ugc_platforms_creator ON ugc_creator_platforms(creator_id);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 6
CREATE INDEX IF NOT EXISTS idx_ugc_creators_handle ON ugc_creators(normalized_handle);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 7
CREATE INDEX IF NOT EXISTS idx_ugc_platforms_platform ON ugc_creator_platforms(platform);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 8
CREATE INDEX IF NOT EXISTS idx_ugc_content_creator ON ugc_content(creator_id);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 9
CREATE INDEX IF NOT EXISTS idx_ugc_content_platform ON ugc_content(creator_platform_id);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 10
CREATE INDEX IF NOT EXISTS idx_ugc_collaborations_creator ON ugc_collaborations(creator_id, updated_at DESC);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 11
CREATE INDEX IF NOT EXISTS idx_ugc_creators_stage ON ugc_creators(lifecycle_stage);

-- Source: db/migrations/0099_ugc_link_health.sql statement 1
-- 0099 — Monthly health checks for public UGC publication links.
--
-- Current state stays on ugc_content for fast operator views. Every attempt is
-- also appended to ugc_link_checks so a transient platform challenge does not
-- erase the previous evidence.

ALTER TABLE ugc_content ADD COLUMN link_status TEXT
  CHECK (link_status IN ('active', 'missing', 'restricted', 'unknown', 'invalid'));

-- Source: db/migrations/0099_ugc_link_health.sql statement 2
ALTER TABLE ugc_content ADD COLUMN link_checked_at TEXT;

-- Source: db/migrations/0099_ugc_link_health.sql statement 3
ALTER TABLE ugc_content ADD COLUMN link_http_status INTEGER;

-- Source: db/migrations/0099_ugc_link_health.sql statement 4
ALTER TABLE ugc_content ADD COLUMN link_final_url TEXT;

-- Source: db/migrations/0099_ugc_link_health.sql statement 5
ALTER TABLE ugc_content ADD COLUMN link_check_note TEXT;

-- Source: db/migrations/0099_ugc_link_health.sql statement 6

CREATE TABLE IF NOT EXISTS ugc_link_checks (
  id            TEXT PRIMARY KEY,
  content_id    TEXT NOT NULL REFERENCES ugc_content(id),
  checked_at    TEXT NOT NULL,
  status        TEXT NOT NULL
    CHECK (status IN ('active', 'missing', 'restricted', 'unknown', 'invalid')),
  http_status   INTEGER,
  final_url     TEXT,
  note          TEXT,
  response_ms   INTEGER
);

-- Source: db/migrations/0100_ugc_product_identification.sql statement 1
-- 0100 — Evidence-backed product identification state for each UGC publication.
-- product_codes remains the raw imported evidence. These fields describe the
-- best completed classification pass without pretending that a missing match
-- is a zero or that a generic visual theme proves a SKU.

ALTER TABLE ugc_content ADD COLUMN product_status TEXT
  CHECK (product_status IN ('identified', 'queued', 'unknown'));

-- Source: db/migrations/0100_ugc_product_identification.sql statement 2
ALTER TABLE ugc_content ADD COLUMN product_source TEXT
  CHECK (product_source IN ('explicit_import', 'metadata_text', 'vision', 'manual'));

-- Source: db/migrations/0100_ugc_product_identification.sql statement 3
ALTER TABLE ugc_content ADD COLUMN product_confidence REAL
  CHECK (product_confidence IS NULL OR (product_confidence >= 0 AND product_confidence <= 1));

-- Source: db/migrations/0100_ugc_product_identification.sql statement 4
ALTER TABLE ugc_content ADD COLUMN product_evidence TEXT;

-- Source: db/migrations/0100_ugc_product_identification.sql statement 5
ALTER TABLE ugc_content ADD COLUMN product_checked_at TEXT;

-- Source: db/migrations/0116_ugc_payouts.sql statement 1
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

-- Source: db/migrations/0116_ugc_payouts.sql statement 2

CREATE INDEX IF NOT EXISTS idx_ugc_payouts_creator ON ugc_payouts(creator_id, updated_at DESC);

-- Source: db/migrations/0116_ugc_payouts.sql statement 3
CREATE INDEX IF NOT EXISTS idx_ugc_payouts_status ON ugc_payouts(status, updated_at DESC);

-- Source: db/migrations/0116_ugc_payouts.sql statement 4
CREATE INDEX IF NOT EXISTS idx_ugc_payouts_day ON ugc_payouts(creator_id, payout_date);

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 1
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

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 2
ALTER TABLE ugc_payouts ADD COLUMN konsol_contractor_id TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 3
ALTER TABLE ugc_payouts ADD COLUMN konsol_payment_id TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 4
ALTER TABLE ugc_payouts ADD COLUMN konsol_status TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 5
ALTER TABLE ugc_payouts ADD COLUMN konsol_error TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 6
ALTER TABLE ugc_payouts ADD COLUMN execute_claim TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 7
ALTER TABLE ugc_payouts ADD COLUMN execute_claimed_at TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 8
ALTER TABLE ugc_payouts ADD COLUMN paid_notice_at TEXT;

-- Source: db/migrations/0119_ugc_payouts_konsol.sql statement 10

CREATE TABLE IF NOT EXISTS ugc_payout_requisites (
  payout_id         TEXT PRIMARY KEY REFERENCES ugc_payouts(id),
  fps_mobile_phone  TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  patronymic        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Source: db/migrations/0120_ugc_ig_messages.sql statement 1
-- 0120 — Instagram Direct for Diana, read by the server (Owner 2026-10-15:
-- «She can check, answer, and do everything even when the browsers are not
-- turned on or the PC is not turned on»).
--
-- One row per Instagram message, keyed by Meta's message id, so a re-read
-- never doubles a row. direction: 'in' from the creator, 'out' from @dasexperten.
-- handled_at stays NULL until Diana has answered or closed the incoming message.
--
-- Additive only. Rollback: DROP TABLE ugc_ig_messages;

CREATE TABLE IF NOT EXISTS ugc_ig_messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_id          TEXT,
  from_username    TEXT,
  text             TEXT,
  attachments_json TEXT,
  created_at       TEXT NOT NULL,
  seen_at          TEXT NOT NULL,
  handled_at       TEXT
);

-- Source: db/migrations/0120_ugc_ig_messages.sql statement 2

CREATE INDEX IF NOT EXISTS idx_ugc_ig_messages_conv ON ugc_ig_messages(conversation_id, created_at);

-- Source: db/migrations/0120_ugc_ig_messages.sql statement 3
CREATE INDEX IF NOT EXISTS idx_ugc_ig_messages_open ON ugc_ig_messages(direction, handled_at, created_at);

-- Source: db/migrations/0121_ugc_creator_status_origin.sql statement 1
-- 0121 — Diana's creator statuses and origin mark (Owner 2026-10-15,
-- DH-LAW-261015-02): every status is one English word of at most 7 letters.
--
-- Main path: new · sent · replied · agreed · cart · payout · paid · ordered ·
--            review · posted · gold
-- Side:      silent · failed · fee · refused · unfit · rival · claim · owner
--
-- origin — who started, set once: 'invited' (we found and wrote first, brown
-- magnifier) or 'self' (the creator came to us, green raised hand). NULL until
-- Diana has established it; the old import does not tell.
--
-- Old stages map: found/qualified → new, invited → sent, accepted → agreed,
-- sample_delivered → ordered, published/orders_mature → posted, renew → gold,
-- stop → refused. Rollback: reverse the UPDATEs; origin is nullable and unused by older code.

ALTER TABLE ugc_creators ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('invited', 'self'));

-- Source: db/migrations/0125_ugc_content_metrics_checked.sql statement 1
-- Diana 2026-10-16: per-publication counts read from the platform itself
-- (likes, views, comments), with the moment they were read.
ALTER TABLE ugc_content ADD COLUMN metrics_checked_at TEXT;

-- Source: db/migrations/0125_ugc_content_metrics_checked.sql statement 2
ALTER TABLE ugc_content ADD COLUMN metrics_source TEXT;

-- Source: db/migrations/0126_ugc_creator_city.sql statement 1
-- Diana 2026-10-16 (Owner: «Город нужен, город обязательно»): the blogger's city,
-- read from the profile name, the handle or her own messages; shown after the name.
ALTER TABLE ugc_creators ADD COLUMN city TEXT;

-- Source: db/migrations/0127_ugc_source_records.sql statement 1
-- Owner 2026-10-16: blogger database evidence, not executable payouts.
CREATE TABLE IF NOT EXISTS ugc_source_records (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES ugc_creators(id),
  creator_platform_id TEXT REFERENCES ugc_creator_platforms(id),
  kind TEXT NOT NULL CHECK (kind IN ('payment_register', 'product_reference')),
  source_document TEXT NOT NULL,
  source_sheet TEXT NOT NULL,
  source_row INTEGER NOT NULL,
  source_text TEXT,
  source_flag TEXT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR currency = 'RUB'),
  product_codes TEXT,
  content_url TEXT,
  imported_at INTEGER NOT NULL,
  UNIQUE(source_document, source_sheet, source_row, kind, creator_id)
);

-- Source: db/migrations/0127_ugc_source_records.sql statement 2
CREATE INDEX IF NOT EXISTS idx_ugc_source_creator ON ugc_source_records(creator_id, kind);

-- Source: db/migrations/0127_ugc_source_records.sql statement 3
CREATE INDEX IF NOT EXISTS idx_ugc_source_profile ON ugc_source_records(creator_platform_id, kind);

-- Source: db/migrations/0128_ugc_payout_product.sql statement 1
-- Owner 2026-10-16: «прежде чем коричневая кнопка будет, должно быть именно название продукта».
-- What the payout pays for (e.g. «TERMO + ETALON»); a payout without it is not payable.
ALTER TABLE ugc_payouts ADD COLUMN product TEXT;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 1
ALTER TABLE ugc_creator_platforms ADD COLUMN avatar_key TEXT;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 2
ALTER TABLE ugc_creator_platforms ADD COLUMN posts_count INTEGER;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 3
ALTER TABLE ugc_creator_platforms ADD COLUMN er_sample_posts INTEGER;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 4
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_checked_at TEXT;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 5
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_attempted_at TEXT;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 6
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_error TEXT;

-- Source: db/migrations/0131_ugc_blogger_profiles.sql statement 7
ALTER TABLE ugc_creator_platforms ADD COLUMN er_checked_at TEXT;

-- Source: db/migrations/0132_ugc_creator_archive.sql statement 1
-- Owner 17 Oct 2026: unavailable Instagram accounts leave the active base.
-- Archive is reversible and preserves payouts, messages and source evidence.
ALTER TABLE ugc_creators ADD COLUMN archived_at INTEGER;

-- Source: db/migrations/0132_ugc_creator_archive.sql statement 2
CREATE INDEX IF NOT EXISTS idx_ugc_creators_archived ON ugc_creators(archived_at);

-- Source: db/migrations/0133_ugc_profile_availability.sql statement 1
-- Owner 2026-10-18: unavailable Instagram accounts stay visible with a faded row.
-- Availability is observed separately from collaboration, payments and archive.
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_status TEXT CHECK (availability_status IN ('available', 'unavailable'));

-- Source: db/migrations/0133_ugc_profile_availability.sql statement 2
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_checked_at TEXT;

-- Source: db/migrations/0133_ugc_profile_availability.sql statement 3
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_note TEXT;

-- Source: db/migrations/0136_ugc_payout_notice_status.sql statement 1
-- Owner 2026-10-19: the paid message has its own status, set only by Instagram's answer to the send.
-- sending → delivered (Instagram returned a message id) | failed (reason) | queued (7-day window closed).
ALTER TABLE ugc_payouts ADD COLUMN notice_status TEXT;

-- Source: db/migrations/0136_ugc_payout_notice_status.sql statement 2
ALTER TABLE ugc_payouts ADD COLUMN notice_error TEXT;

-- Source: db/migrations/0136_ugc_payout_notice_status.sql statement 3
ALTER TABLE ugc_payouts ADD COLUMN notice_message_id TEXT;

-- Source: db/migrations/0136_ugc_payout_notice_status.sql statement 4
ALTER TABLE ugc_payouts ADD COLUMN notice_at TEXT;

-- Source: db/migrations/0150_ugc_creator_accepted_at.sql statement 1
-- Owner 2026-11-04: a creator who accepted and has no reel for more than 10 days shows on a light brown row.
-- The clock is the payment date; without a payment, the moment the creator entered an accepted stage.
-- Accepted stages: agreed, cart, paid, ordered, creation. The stamp is set by the database itself,
-- so every writer (the page, Diana's Instagram replies, imports) is covered without code changes.
ALTER TABLE ugc_creators ADD COLUMN accepted_at INTEGER;

-- Source: db/migrations/0150_ugc_creator_accepted_at.sql statement 3

CREATE TRIGGER IF NOT EXISTS ugc_creators_accepted_at_upd
AFTER UPDATE OF lifecycle_stage ON ugc_creators
WHEN NEW.lifecycle_stage IN ('agreed','cart','paid','ordered','creation')
 AND (OLD.lifecycle_stage IS NULL OR OLD.lifecycle_stage NOT IN ('agreed','cart','paid','ordered','creation'))
BEGIN
  UPDATE ugc_creators SET accepted_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;

-- Source: db/migrations/0150_ugc_creator_accepted_at.sql statement 4

CREATE TRIGGER IF NOT EXISTS ugc_creators_accepted_at_ins
AFTER INSERT ON ugc_creators
WHEN NEW.lifecycle_stage IN ('agreed','cart','paid','ordered','creation') AND NEW.accepted_at IS NULL
BEGIN
  UPDATE ugc_creators SET accepted_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;

-- Source: db/migrations/0151_ugc_handle_history.sql statement 1
-- Owner 2026-11-04: an Instagram creator who changed the account name is not gone.
-- The ERP finds the new name, puts it on the card at once and keeps the old one here.
CREATE TABLE IF NOT EXISTS ugc_handle_history (
  id                  TEXT PRIMARY KEY,
  creator_platform_id TEXT NOT NULL REFERENCES ugc_creator_platforms(id),
  platform            TEXT NOT NULL,
  old_handle          TEXT NOT NULL,
  new_handle          TEXT NOT NULL,
  evidence            TEXT NOT NULL,
  changed_at          TEXT NOT NULL
);

-- Source: db/migrations/0151_ugc_handle_history.sql statement 2
CREATE INDEX IF NOT EXISTS idx_ugc_handle_history_profile ON ugc_handle_history(creator_platform_id, changed_at DESC);

-- Source: db/migrations/0151_ugc_handle_history.sql statement 3
CREATE INDEX IF NOT EXISTS idx_ugc_handle_history_old ON ugc_handle_history(platform, old_handle);

-- Source: db/migrations/0151_ugc_handle_history.sql statement 4
ALTER TABLE ugc_creator_platforms ADD COLUMN rename_checked_at TEXT;

-- Source: db/migrations/20260919_wb_gateway.sql statement 4
CREATE TABLE IF NOT EXISTS erp_job_claims (worker TEXT PRIMARY KEY, slot TEXT NOT NULL, lease_until INTEGER NOT NULL);

