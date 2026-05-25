-- =============================================================================
-- Migration 0048 — Self-healing infrastructure
--
-- Three tables form the watchdog/journal/playbook stack:
--   sync_failures        — append-only audit of every cron failure
--   auto_heal_recipes    — playbook: error pattern → safe action
--   auto_heal_log        — what auto-healer did, when, and why
--
-- Seeded with one recipe: recreate bank_statement_files when its FK dangles.
-- New recipes extend the playbook over time as new failure patterns emerge.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sync_failures (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  cron_expression TEXT,
  occurred_at INTEGER NOT NULL,
  error_message TEXT NOT NULL,
  error_class TEXT,
  raw_context TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  auto_heal_log_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_failures_service_time ON sync_failures(service_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_failures_recent ON sync_failures(occurred_at DESC);

CREATE TABLE IF NOT EXISTS auto_heal_recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  error_pattern TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_config TEXT NOT NULL DEFAULT '{}',
  max_per_hour INTEGER NOT NULL DEFAULT 3,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_enabled ON auto_heal_recipes(enabled);

CREATE TABLE IF NOT EXISTS auto_heal_log (
  id TEXT PRIMARY KEY,
  recipe_id TEXT,
  service_name TEXT NOT NULL,
  triggered_by_error TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failed','skipped_rate_limited','skipped_no_recipe')),
  details TEXT,
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER,
  FOREIGN KEY (recipe_id) REFERENCES auto_heal_recipes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_heal_log_service_time ON auto_heal_log(service_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_heal_log_recipe ON auto_heal_log(recipe_id, occurred_at DESC);

INSERT INTO auto_heal_recipes (id, name, error_pattern, action_type, action_config, max_per_hour, enabled, description, created_at, updated_at)
VALUES (
  'recipe_dangling_bsf',
  'Recreate bank_statement_files',
  'no such table:.*bank_statement_files',
  'create_known_table',
  '{"table_name":"bank_statement_files"}',
  2,
  1,
  'When bank_transactions FK to bank_statement_files dangles, recreate the table with the minimal schema from migration 0047.',
  unixepoch(),
  unixepoch()
);
