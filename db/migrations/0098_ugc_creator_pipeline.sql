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

CREATE INDEX IF NOT EXISTS idx_ugc_platforms_creator ON ugc_creator_platforms(creator_id);
CREATE INDEX IF NOT EXISTS idx_ugc_creators_handle ON ugc_creators(normalized_handle);
CREATE INDEX IF NOT EXISTS idx_ugc_platforms_platform ON ugc_creator_platforms(platform);
CREATE INDEX IF NOT EXISTS idx_ugc_content_creator ON ugc_content(creator_id);
CREATE INDEX IF NOT EXISTS idx_ugc_content_platform ON ugc_content(creator_platform_id);
CREATE INDEX IF NOT EXISTS idx_ugc_collaborations_creator ON ugc_collaborations(creator_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_creators_stage ON ugc_creators(lifecycle_stage);
