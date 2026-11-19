-- Context for a saved human reply. No passwords, sessions, or access changes.
CREATE TABLE IF NOT EXISTS email_draft_reply_context (
  draft_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  in_reply_to TEXT NOT NULL,
  references_json TEXT NOT NULL DEFAULT '[]',
  reply_to_tag TEXT NOT NULL DEFAULT '',
  body_sha256 TEXT NOT NULL,
  html TEXT NOT NULL
);
