-- Diana 2026-10-16: per-publication counts read from the platform itself
-- (likes, views, comments), with the moment they were read.
ALTER TABLE ugc_content ADD COLUMN metrics_checked_at TEXT;
ALTER TABLE ugc_content ADD COLUMN metrics_source TEXT;
