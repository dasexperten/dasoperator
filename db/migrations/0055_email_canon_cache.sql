-- Migration 0055: D1 hot cache for the distilled canon (one cache).
-- Source of truth stays R2 (email-canon/) + GitHub; this is the fast read layer the engine uses.
CREATE TABLE IF NOT EXISTS email_canon (
  branch     TEXT NOT NULL,
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (branch, key)
);
