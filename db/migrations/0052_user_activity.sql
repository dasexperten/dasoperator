-- 0052_user_activity.sql
-- Per-user activity log feeding the team-activity dashboard.
-- Append-only: one row per login / heartbeat / logout event.
--   kind='login'      written once when the app boots after auth
--   kind='heartbeat'  written every ~30s while the tab is open;
--                     active=1 when mouse/keyboard moved within the interval
--   kind='logout'     written on explicit sign-out
-- In-system time = heartbeat count * interval; active time = SUM(active) * interval.
-- (table already created live in das_erp_dev; this keeps the repo in sync)

CREATE TABLE IF NOT EXISTS user_activity (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  session_token TEXT,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('login', 'heartbeat', 'logout')),
  active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  path          TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_activity_user_ts ON user_activity(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_user_activity_ts ON user_activity(ts);
