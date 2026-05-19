-- Migration 0044: Planner foundation
-- Adds lifecycle status, base_sku linking for bundles, and planner_runs history table.
-- Foundation for the Procurement Planner module (one cycle = one manufacturer = one draft).

-- 1. lifecycle_status: active / paused / archived / new_launch
ALTER TABLE products ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';

-- 2. base_sku: link bundle SKUs (DE107AA, DE107AAAA) back to base (DE107)
ALTER TABLE products ADD COLUMN base_sku TEXT;

-- 3. populate base_sku for AAAA (4in1) bundles by stripping last 4 chars
UPDATE products
SET base_sku = SUBSTR(id, 1, LENGTH(id) - 4)
WHERE id LIKE '%aaaa' AND deleted_at IS NULL;

-- 4. populate base_sku for AA (2in1) bundles by stripping last 2 chars
UPDATE products
SET base_sku = SUBSTR(id, 1, LENGTH(id) - 2)
WHERE id LIKE '%aa' AND id NOT LIKE '%aaaa' AND deleted_at IS NULL;

-- 5. planner_runs: history of planner sessions
-- One row per planner cycle. Linked to manufacturer_group_id (Honghui+WDAA share honghui_group).
-- operation_id is set when user clicks Create Draft Purchase.
CREATE TABLE IF NOT EXISTS planner_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  manufacturer_group_id TEXT NOT NULL REFERENCES manufacturer_groups(id),
  window_days INTEGER NOT NULL DEFAULT 60,
  coverage_days INTEGER NOT NULL DEFAULT 60,
  lead_time_days INTEGER NOT NULL DEFAULT 65,
  scenario_chosen TEXT,
  total_units INTEGER,
  total_volume_m3_micro INTEGER,
  operation_id TEXT REFERENCES operations(id),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_planner_runs_group_time
  ON planner_runs(manufacturer_group_id, created_at);
