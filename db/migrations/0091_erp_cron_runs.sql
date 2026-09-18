-- One row per tick of every erp-* timer worker (workers/erp-*).
-- The ERP "Timers" screen reads it; the */10 watchdog reports failed rows to Telegram once.
CREATE TABLE IF NOT EXISTS erp_cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  worker      TEXT    NOT NULL,
  cron        TEXT    NOT NULL,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  rows        INTEGER,
  note        TEXT,
  error       TEXT,
  notified    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_erp_cron_runs_worker ON erp_cron_runs (worker, id DESC);
CREATE INDEX IF NOT EXISTS idx_erp_cron_runs_failed ON erp_cron_runs (ok, notified, finished_at);
