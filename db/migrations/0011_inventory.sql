-- =============================================================================
-- Phase 4.1 — Inventory module schema
-- Hybrid perpetual model: real-time movements + periodic sessions
-- Trust the count: session discrepancy → automatic adjustment movement
-- Pieces + master case: stock stored in pieces, UI accepts both
-- =============================================================================
-- NOTE: stocks and inventory_sessions were originally created as stub tables
-- in migration 0001_init.sql (Phase 1.1) but never used in production.
-- Both verified empty (0 rows) before this migration was authored.
-- Hard-replace with the new schema designed for Phase 4 hybrid model.
-- =============================================================================

DROP TABLE IF EXISTS inventory_items;     -- legacy, unused
DROP TABLE IF EXISTS inventory_sessions;  -- legacy, will recreate with new shape
DROP TABLE IF EXISTS stocks;              -- legacy, will recreate with new shape

-- -----------------------------------------------------------------------------
-- products: add pieces_per_case
-- -----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN pieces_per_case INTEGER NOT NULL DEFAULT 1
  CHECK (pieces_per_case >= 1);

-- -----------------------------------------------------------------------------
-- stocks: current on-hand cache (denormalized sum of movements)
-- One row per (warehouse, product). Recomputed on every movement insert.
-- Pieces only — UI does pieces↔cases conversion using product.pieces_per_case.
-- -----------------------------------------------------------------------------
CREATE TABLE stocks (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  on_hand INTEGER NOT NULL DEFAULT 0,
  last_movement_at INTEGER,
  last_counted_at INTEGER,
  last_counted_by TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE (warehouse_id, product_id)
);

CREATE INDEX idx_stocks_warehouse ON stocks(warehouse_id);
CREATE INDEX idx_stocks_product   ON stocks(product_id);

-- -----------------------------------------------------------------------------
-- stock_movements: append-only journal of every change
-- Source field future-proofs external sync (wb / ozon / 3pl / api / cron).
-- -----------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'receipt', 'shipment', 'transfer_in', 'transfer_out',
    'adjustment', 'session_correction', 'sync_correction',
    'opening_balance', 'write_off', 'return'
  )),
  quantity INTEGER NOT NULL,                 -- signed; +receipt, -shipment, etc.
  source TEXT NOT NULL CHECK (source IN (
    'manual', 'operation', 'session', 'sync_wb', 'sync_ozon',
    'sync_3pl', 'sync_api', 'cron', 'opening'
  )),
  source_ref_type TEXT,                      -- 'operation' | 'session' | 'sync' | NULL
  source_ref_id TEXT,                        -- FK-ish, not enforced (cross-table)
  reason TEXT,                               -- free text or enum from UI
  notes TEXT,
  performed_by TEXT,                         -- user / system / sync agent
  performed_at INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,            -- cached for journal display
  created_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE INDEX idx_movements_warehouse_product ON stock_movements(warehouse_id, product_id);
CREATE INDEX idx_movements_performed         ON stock_movements(performed_at DESC);
CREATE INDEX idx_movements_source_ref        ON stock_movements(source_ref_type, source_ref_id);
CREATE INDEX idx_movements_type              ON stock_movements(movement_type);
CREATE INDEX idx_movements_source            ON stock_movements(source);

-- -----------------------------------------------------------------------------
-- inventory_sessions: physical count campaigns
-- Trust the count: on commit, discrepancies become session_correction movements
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_sessions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,            -- INV-YYYYMM-NNNN
  warehouse_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'counting', 'committed', 'cancelled'
  )),
  scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'partial', 'spot')),
  started_at INTEGER NOT NULL,
  started_by TEXT,
  committed_at INTEGER,
  committed_by TEXT,
  cancelled_at INTEGER,
  cancelled_by TEXT,
  notes TEXT,
  total_lines INTEGER NOT NULL DEFAULT 0,
  total_discrepancies INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
);

CREATE INDEX idx_sessions_warehouse ON inventory_sessions(warehouse_id);
CREATE INDEX idx_sessions_status    ON inventory_sessions(status);
CREATE INDEX idx_sessions_started   ON inventory_sessions(started_at DESC);

-- -----------------------------------------------------------------------------
-- session_lines: one row per SKU counted in a session
-- system_qty is snapshotted at line creation, counted_qty entered by counter
-- discrepancy = counted_qty - system_qty (computed at commit time)
-- -----------------------------------------------------------------------------
CREATE TABLE session_lines (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  system_qty INTEGER NOT NULL,               -- snapshot of stocks.on_hand at line creation
  counted_qty INTEGER,                       -- NULL until counted
  counted_cases INTEGER,                     -- UI breakdown for audit
  counted_pieces INTEGER,                    -- UI breakdown for audit
  discrepancy INTEGER,                       -- counted_qty - system_qty, set at commit
  reason TEXT,                               -- optional in trust-the-count mode
  counted_at INTEGER,
  counted_by TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE (session_id, product_id)
);

CREATE INDEX idx_session_lines_session ON session_lines(session_id);
CREATE INDEX idx_session_lines_product ON session_lines(product_id);

-- -----------------------------------------------------------------------------
-- sequences: add INV counter for inventory session references
-- -----------------------------------------------------------------------------
-- NOTE: sequences table schema (per migration 0001):
--   (id, description, next_number, padding, format_example, updated_at)
-- The "INV-{YYYYMM}-{NNNN}" formatting is implemented in app code via
-- formatSequenceValue() in sequence-format.ts — DB stores only the seed.
INSERT INTO sequences (id, description, next_number, padding, format_example, updated_at)
VALUES ('seq_inv', 'Inventory session reference counter', 1, 4,
        'INV-202605-0001', strftime('%s','now'));
