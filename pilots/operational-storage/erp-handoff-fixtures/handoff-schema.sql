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

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 10
CREATE INDEX IF NOT EXISTS idx_ugc_collaborations_creator ON ugc_collaborations(creator_id, updated_at DESC);

-- Source: db/migrations/0098_ugc_creator_pipeline.sql statement 11
CREATE INDEX IF NOT EXISTS idx_ugc_creators_stage ON ugc_creators(lifecycle_stage);

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

-- Source: db/migrations/0126_ugc_creator_city.sql statement 1
-- Diana 2026-10-16 (Owner: «Город нужен, город обязательно»): the blogger's city,
-- read from the profile name, the handle or her own messages; shown after the name.
ALTER TABLE ugc_creators ADD COLUMN city TEXT;

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

