-- Migration 0062: Emailer Dark UI v3 — release 1 foundation.
-- Read/unread state per message, a lightweight attention learning log, and
-- versioning for the cached AI summary (v1 = 2-sentence preview, v2 = 3-4
-- line "what they want" digest). Read/unread lives outside R2 (R2 index is
-- append-only, never rewritten in place).

CREATE TABLE IF NOT EXISTS email_read_state (
  message_key TEXT PRIMARY KEY,   -- R2 record key, e.g. Inbox/sales@.../received/...json
  mailbox     TEXT NOT NULL,
  read_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_read_state_mailbox ON email_read_state(mailbox);

CREATE TABLE IF NOT EXISTS email_attention_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  correspondent TEXT NOT NULL,
  message_key TEXT NOT NULL,
  signal      TEXT NOT NULL,   -- attention_shown | attention_clicked | replied_after | summary_expanded
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_attention_log_correspondent ON email_attention_log(correspondent);

-- email_summaries is created lazily (CREATE TABLE IF NOT EXISTS) by
-- email-archive.ts on first use, so ALTER here must tolerate a table that
-- may not exist yet in a fresh environment.
CREATE TABLE IF NOT EXISTS email_summaries (
  msg_key TEXT PRIMARY KEY, summary TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL
);
ALTER TABLE email_summaries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
