-- 0099 — Monthly health checks for public UGC publication links.
--
-- Current state stays on ugc_content for fast operator views. Every attempt is
-- also appended to ugc_link_checks so a transient platform challenge does not
-- erase the previous evidence.

ALTER TABLE ugc_content ADD COLUMN link_status TEXT
  CHECK (link_status IN ('active', 'missing', 'restricted', 'unknown', 'invalid'));
ALTER TABLE ugc_content ADD COLUMN link_checked_at TEXT;
ALTER TABLE ugc_content ADD COLUMN link_http_status INTEGER;
ALTER TABLE ugc_content ADD COLUMN link_final_url TEXT;
ALTER TABLE ugc_content ADD COLUMN link_check_note TEXT;

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

CREATE INDEX IF NOT EXISTS idx_ugc_content_link_due
  ON ugc_content(link_checked_at, id)
  WHERE content_url IS NOT NULL AND TRIM(content_url) <> '';
CREATE INDEX IF NOT EXISTS idx_ugc_link_checks_content
  ON ugc_link_checks(content_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_link_checks_checked
  ON ugc_link_checks(checked_at DESC);
