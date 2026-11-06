-- Owner 2026-11-07: double click selects one reel for Dieter. Publication proof is separate from selection.
CREATE TABLE IF NOT EXISTS ugc_reel_jobs (
  content_id TEXT PRIMARY KEY REFERENCES ugc_content(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','working','published')),
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
  CHECK(status <> 'published' OR (published_at IS NOT NULL AND publications <> '[]'))
);
CREATE INDEX IF NOT EXISTS idx_ugc_reel_jobs_queue ON ugc_reel_jobs(status, requested_at);
