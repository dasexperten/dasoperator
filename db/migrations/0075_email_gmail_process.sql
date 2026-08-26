-- Gmail-process layer for ERP Emailer.
-- Flags and drafts live in D1 (R2 archive stays append-only).
-- Transport (Resend / Cloudflare Email Routing) is unchanged.

CREATE TABLE IF NOT EXISTS email_flags (
  message_key TEXT PRIMARY KEY,
  mailbox     TEXT NOT NULL,
  starred     INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  trashed     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_flags_mailbox ON email_flags(mailbox);
CREATE INDEX IF NOT EXISTS idx_email_flags_starred ON email_flags(starred);
CREATE INDEX IF NOT EXISTS idx_email_flags_archived ON email_flags(archived);

CREATE TABLE IF NOT EXISTS email_drafts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  mailbox     TEXT NOT NULL,
  to_addr     TEXT NOT NULL DEFAULT '',
  cc_addr     TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_drafts_user ON email_drafts(user_id, updated_at);
