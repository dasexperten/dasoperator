-- Additive API journal. Existing reel-job frames, dates and proofs are untouched.
CREATE TABLE ugc_instagram_operations (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES ugc_reel_jobs(content_id),
  account TEXT NOT NULL CHECK(account='dasexperten'),
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  caption TEXT NOT NULL,
  caption_sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  container_id TEXT,
  media_id TEXT,
  permalink TEXT,
  verification_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(content_id,account)
);
CREATE TABLE ugc_instagram_operation_events (
  operation_id TEXT NOT NULL REFERENCES ugc_instagram_operations(id),
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,sequence)
);
CREATE UNIQUE INDEX ugc_instagram_unique_media ON ugc_instagram_operations(account,media_id) WHERE media_id IS NOT NULL;
CREATE UNIQUE INDEX ugc_instagram_unique_container ON ugc_instagram_operations(account,container_id) WHERE container_id IS NOT NULL;
CREATE UNIQUE INDEX ugc_instagram_unique_file ON ugc_instagram_operations(account,source_sha256);
