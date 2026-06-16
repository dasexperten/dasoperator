-- Migration 0054: Email Tasks — agent task conveyor + learning loop
-- =============================================================================
-- Reframes the Emailer module from "compose & send" into a TASKS command center.
--
-- Five tables:
--   email_scenarios   — automated cron scenarios (the "Pochtalon Pechkin" jobs)
--   email_agent_tasks — the live queue: incoming -> agent draft -> your OK -> sent
--   email_lessons     — proposed lessons captured from your Safety Gate edits
--   email_playbook    — the approved canon (mirrors GitHub source of truth)
--   email_settings    — global flags (auto-learning on/off, threshold)
--
-- Executor model: each scenario runs on 'worker' (Cloudflare, deterministic)
-- or 'hermes' (VPS agent, reasons + learns). Sending ALWAYS goes through the
-- emailer-bridge — no table here ever sends; they only record state.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Scenarios — one row per automated email job
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_scenarios (
  id            TEXT PRIMARY KEY,                       -- slug, e.g. 'ozon-complaint'
  name          TEXT NOT NULL,                          -- display name
  description   TEXT,
  executor      TEXT NOT NULL DEFAULT 'worker'
                  CHECK (executor IN ('worker', 'hermes')),
  inbox         TEXT NOT NULL,                          -- ALLOWED_SENDER_INBOX, e.g. 'sales@dasexperten.de'
  from_address  TEXT NOT NULL DEFAULT 'dasexperten@gmail.com', -- explicit From (SPF rule for cron)
  schedule_cron TEXT NOT NULL DEFAULT '23 */3 * * *',   -- every 3h at :23 UTC
  trigger_spec  TEXT,                                   -- JSON: keywords, filters, newer_than, skip-addresses
  persona_rule  TEXT,                                   -- gender-mirror / UGC-female / staff-router note
  enabled       INTEGER NOT NULL DEFAULT 1,
  auto_learning INTEGER NOT NULL DEFAULT 0,             -- per-scenario auto-approve of high-confidence lessons
  sent_clean    INTEGER NOT NULL DEFAULT 0,             -- accuracy curve: drafts sent without your edit
  edited        INTEGER NOT NULL DEFAULT 0,             -- drafts you edited before sending
  last_run_at   INTEGER,
  next_run_at   INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- Agent task queue — one row per incoming item the agent works
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_agent_tasks (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES email_scenarios(id),
  source_email_id TEXT,                                 -- link to inbox message/thread
  subject         TEXT,
  sender          TEXT,
  status          TEXT NOT NULL DEFAULT 'researching'
                    CHECK (status IN ('researching','draft_ready','awaiting_ok','sent','rejected','skipped')),
  draft_body      TEXT,
  confidence      REAL,                                 -- 0..1 agent self-score
  executor        TEXT NOT NULL DEFAULT 'worker'
                    CHECK (executor IN ('worker','hermes')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_tasks_status   ON email_agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_email_tasks_scenario ON email_agent_tasks(scenario_id);

-- ---------------------------------------------------------------------------
-- Lessons — proposed from your Safety Gate edits (the learning signal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_lessons (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL REFERENCES email_scenarios(id),
  task_id      TEXT REFERENCES email_agent_tasks(id),   -- origin edit
  proposed     TEXT NOT NULL,                           -- one-line generalization
  diff_before  TEXT,                                    -- what the agent wrote
  diff_after   TEXT,                                    -- what you sent
  seen_count   INTEGER NOT NULL DEFAULT 1,              -- how often this pattern recurred
  source       TEXT NOT NULL DEFAULT 'hermes',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','auto_approved')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at   INTEGER,
  decided_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_lessons_status   ON email_lessons(status);
CREATE INDEX IF NOT EXISTS idx_email_lessons_scenario ON email_lessons(scenario_id);

-- ---------------------------------------------------------------------------
-- Playbook — the approved canon (mirror of GitHub source of truth)
-- 'lesson' rows guide the agent; 'stop_phrase' rows are rejected patterns it
-- must never propose again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_playbook (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL DEFAULT 'global',      -- scenario slug or 'global'
  lesson           TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'lesson'
                     CHECK (kind IN ('lesson','stop_phrase')),
  active           INTEGER NOT NULL DEFAULT 1,
  commit_sha       TEXT,                                -- GitHub canon commit
  source_lesson_id TEXT REFERENCES email_lessons(id),
  approved_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  approved_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_playbook_scenario ON email_playbook(scenario_id);
CREATE INDEX IF NOT EXISTS idx_email_playbook_active   ON email_playbook(active);

-- ---------------------------------------------------------------------------
-- Settings — global key/value (auto-learning master switch + threshold)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO email_settings (key, value) VALUES
  ('auto_learning', 'off'),            -- 'off' = every lesson needs your click
  ('auto_learning_min_seen', '3'),     -- auto-approve only after N recurrences
  ('auto_learning_min_confidence', '0.85');
