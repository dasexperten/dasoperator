-- =============================================================================
-- 0032_otw_and_stock_state.sql
-- Add OTW (on-the-way) virtual warehouse + stock state dimension.
--
-- Background (purchase lifecycle, per Aram 2026-05-11):
--   issued     → docs created, debt arises, NO stock movement
--   production → factory started making it. Quantity appears at FACTORY
--                warehouse (gzh/yzh) with stock_state='in_production'
--                (rendered green in UI as "+15" suffix on factory cell).
--   shipped    → quantity LEAVES factory (in_production row -= qty),
--                APPEARS in wh_otw with stock_state='in_transit'
--                (rendered as yellow OTW column cell).
--   delivered  → quantity LEAVES wh_otw (in_transit row -= qty),
--                APPEARS at destination warehouse with stock_state='on_hand'
--                (rendered as plain black number, normal stock).
--                THIS TRANSITION IS AUTOMATIC — triggered when destination
--                warehouse API (WB/Ozon FBO, FBS Lyubertsy, etc.) confirms
--                actual physical receipt. Not a manual button.
--   cancelled  → reverses everything to whichever state it was in.
--
-- Why a single OTW warehouse instead of per-route:
--   Simpler accounting. Aram only needs to see "something is in transit"
--   without tracking the specific corridor at this stage.
--
-- Why stock_state instead of separate tables:
--   One product can simultaneously be on_hand AND in_production at the
--   same factory warehouse (80 finished + 15 being made), and we need
--   to show them with different colors. Three rows in stocks per
--   (warehouse, product) instead of three tables = clean queries.
-- =============================================================================

-- Step 1: Create OTW virtual warehouse
INSERT INTO warehouses (
  id, code, name, country, city, warehouse_type,
  owner_company_id, notes,
  created_at, updated_at
) VALUES (
  'wh_otw', 'OTW', 'On The Way (in transit)', NULL, NULL, 'external',
  NULL, 'Virtual warehouse: holds goods that have left origin but not yet arrived at destination. Quantity here = sum of all shipped-but-not-delivered purchases and transfers.',
  unixepoch(), unixepoch()
);

-- Step 2: Add stock_state column to stocks
-- D1 / SQLite cannot ALTER existing UNIQUE constraint, so:
--   2a. add stock_state column with default 'on_hand'
--   2b. create new table with the right UNIQUE(warehouse_id, product_id, stock_state)
--   2c. copy data
--   2d. drop old, rename new
ALTER TABLE stocks ADD COLUMN stock_state TEXT NOT NULL DEFAULT 'on_hand'
  CHECK (stock_state IN ('on_hand', 'in_production', 'in_transit'));

-- Step 3: Recreate stocks table with composite UNIQUE that includes stock_state.
-- This is the only way in SQLite/D1 to change a UNIQUE constraint.

CREATE TABLE stocks_new (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  stock_state TEXT NOT NULL DEFAULT 'on_hand'
    CHECK (stock_state IN ('on_hand', 'in_production', 'in_transit')),
  on_hand INTEGER NOT NULL DEFAULT 0,
  last_movement_at INTEGER,
  last_counted_at INTEGER,
  last_counted_by TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE (warehouse_id, product_id, stock_state)
);

INSERT INTO stocks_new (id, warehouse_id, product_id, stock_state, on_hand, last_movement_at, last_counted_at, last_counted_by, updated_at)
  SELECT id, warehouse_id, product_id, stock_state, on_hand, last_movement_at, last_counted_at, last_counted_by, updated_at
  FROM stocks;

DROP TABLE stocks;

ALTER TABLE stocks_new RENAME TO stocks;

-- Step 4: Extend stock_movements movement_type with new transitions for
-- the purchase lifecycle. SQLite does not allow ALTER CHECK either, so
-- table recreate is required.

CREATE TABLE stock_movements_new (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'receipt', 'shipment', 'transfer_in', 'transfer_out',
    'adjustment', 'session_correction', 'sync_correction',
    'opening_balance', 'write_off', 'return',
    -- New lifecycle movements for purchase + transfer:
    'production_reserve',   -- factory started production, +qty at factory in_production
    'production_release',   -- factory finished, qty leaves in_production (paired with shipment_out)
    'shipment_out',         -- qty leaves origin warehouse on_hand or in_production
    'in_transit_in',        -- qty arrives at OTW virtual warehouse in_transit
    'in_transit_out',       -- qty leaves OTW (delivered confirmed)
    'arrival'               -- qty arrives at destination warehouse on_hand
  )),
  quantity INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN (
    'manual', 'operation', 'session', 'sync_wb', 'sync_ozon',
    'sync_3pl', 'sync_api', 'cron', 'opening'
  )),
  source_ref_type TEXT,
  source_ref_id TEXT,
  reason TEXT,
  notes TEXT,
  performed_by TEXT,
  performed_at INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  stock_state TEXT NOT NULL DEFAULT 'on_hand'
    CHECK (stock_state IN ('on_hand', 'in_production', 'in_transit')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

INSERT INTO stock_movements_new (id, warehouse_id, product_id, movement_type, quantity, source, source_ref_type, source_ref_id, reason, notes, performed_by, performed_at, balance_after, stock_state, created_at)
  SELECT id, warehouse_id, product_id, movement_type, quantity, source, source_ref_type, source_ref_id, reason, notes, performed_by, performed_at, balance_after, 'on_hand', created_at
  FROM stock_movements;

DROP TABLE stock_movements;

ALTER TABLE stock_movements_new RENAME TO stock_movements;

-- Useful indexes for the new queries the UI will make:
CREATE INDEX idx_stocks_state ON stocks(warehouse_id, stock_state);
CREATE INDEX idx_movements_op ON stock_movements(source_ref_id, source_ref_type);
