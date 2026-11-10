-- Owner 10.11: provider acceptance finishes uploader work, public proof stays separate.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE ugc_reel_jobs_uploaded (
  content_id TEXT PRIMARY KEY REFERENCES ugc_content(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','uploaded','published')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  published_at TEXT,
  claim_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  dispatched_at TEXT,
  last_error TEXT,
  publications TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  consumer_id TEXT,
  acknowledged_at TEXT,
  required_destinations TEXT NOT NULL DEFAULT '[]',
  CHECK(status <> 'published' OR (published_at IS NOT NULL AND publications <> '[]'))
);
INSERT INTO ugc_reel_jobs_uploaded SELECT * FROM ugc_reel_jobs;
DROP TABLE ugc_reel_jobs;
ALTER TABLE ugc_reel_jobs_uploaded RENAME TO ugc_reel_jobs;
CREATE INDEX idx_ugc_reel_jobs_queue ON ugc_reel_jobs(status,requested_at);
-- The final FK graph retains its original names; validate it after replacement.
PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys=OFF;
