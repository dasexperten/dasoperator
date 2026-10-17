-- Owner 17 Oct 2026: unavailable Instagram accounts leave the active base.
-- Archive is reversible and preserves payouts, messages and source evidence.
ALTER TABLE ugc_creators ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_ugc_creators_archived ON ugc_creators(archived_at);
