-- Migration 0057: email_classifications — INTERNAL email-type tags (NOT shown on frontend).
-- Each email gets an email_type (heuristic or LLM) so Forward/Delete buttons can write
-- proper two-layer sender×type rules, and triage can route by type. Invisible to the UI.
CREATE TABLE IF NOT EXISTS email_classifications (
  thread_id   TEXT PRIMARY KEY,
  sender      TEXT,
  email_type  TEXT NOT NULL,
  confidence  REAL,
  source      TEXT,            -- heuristic | llm
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_class_type ON email_classifications(email_type);
