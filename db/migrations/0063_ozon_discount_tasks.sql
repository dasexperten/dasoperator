-- =============================================================================
-- Migration 0063: Ozon discount-request workflow log (Tamara care lane).
--
-- Owner 2026-07-21: buyer discount requests on Ozon are processed every
-- morning by the worker (lib/ozon-discounts.ts, cron 0 6 * * *): approved
-- within the care law (5% grant, 6% cap, 0.8xmin floor) with a conversion
-- seller comment. This table is the per-task audit trail behind
-- marketplace_sync_log rows (marketplace='ozon-discounts').
-- =============================================================================

CREATE TABLE IF NOT EXISTS ozon_discount_tasks (
  task_id INTEGER PRIMARY KEY,
  offer_id TEXT,
  sku INTEGER,
  base_price REAL,
  requested_price REAL,
  approved_price REAL,
  action TEXT NOT NULL,          -- 'approved' | 'escalated'
  seller_comment TEXT,
  processed_at INTEGER NOT NULL, -- unix seconds
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_ozon_discount_tasks_processed
  ON ozon_discount_tasks (processed_at DESC);
