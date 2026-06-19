-- Migration 0056: Email Rules — two-layer (sender × type)
-- Rules learn on TWO axes: SENDER and email TYPE. One sender (e.g. Ozon) can carry
-- several types with different actions: acceptance/приёмка => exclude, news => attention.
-- email_rules currently has 0 rows, so we rebuild cleanly.

DROP TABLE IF EXISTS email_rules;

CREATE TABLE email_rules (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL DEFAULT 'default',
  match_sender    TEXT,            -- sender axis: domain/email/regex; NULL = any sender
  email_type      TEXT,            -- type axis: acceptance|news|promo|otp|order_issue|invoice|contract|partner|newsletter|... ; NULL = any type
  action          TEXT NOT NULL CHECK (action IN ('exclude','attention','keep','delete','forward','archive')),
  target          TEXT,            -- e.g. forward-to address
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','learned')),
  confidence      REAL,            -- for learned rules
  enabled         INTEGER NOT NULL DEFAULT 1,
  match_count     INTEGER NOT NULL DEFAULT 0,
  last_matched_at INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
-- A rule with BOTH match_sender and email_type = sender×type intersection (the precise default).
-- Only match_sender = whole-sender rule. Only email_type = that type for everyone.

CREATE INDEX idx_email_rules_sender  ON email_rules(match_sender);
CREATE INDEX idx_email_rules_type    ON email_rules(email_type);
CREATE INDEX idx_email_rules_enabled ON email_rules(enabled);