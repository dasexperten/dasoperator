-- Migration 0053: Email Rules
-- Creates email_rules table for forwarding/deletion rules.

CREATE TABLE IF NOT EXISTS email_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  rule_type TEXT NOT NULL CHECK (rule_type IN ('forward', 'auto_delete', 'archive')),
  pattern TEXT NOT NULL,
  action TEXT,
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index for faster user-based lookups
CREATE INDEX IF NOT EXISTS idx_email_rules_user_id ON email_rules(user_id);

-- Index for rule_type queries
CREATE INDEX IF NOT EXISTS idx_email_rules_rule_type ON email_rules(rule_type);
