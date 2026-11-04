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
CREATE INDEX IF NOT EXISTS idx_ugc_handle_history_profile ON ugc_handle_history(creator_platform_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ugc_handle_history_old ON ugc_handle_history(platform, old_handle);
ALTER TABLE ugc_creator_platforms ADD COLUMN rename_checked_at TEXT;
