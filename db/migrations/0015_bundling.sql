-- =============================================================================
-- 0015_bundling.sql
-- Add 'bundling' to operations.operation_type CHECK constraint.
-- SQLite does not support ALTER COLUMN — requires table recreation.
-- Also creates bundling_items table for pack/unpack line pairs.
-- =============================================================================

PRAGMA foreign_keys = OFF;

-- Step 1: rename existing table
ALTER TABLE operations RENAME TO operations_old;

-- Step 2: recreate with bundling added to CHECK
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  operation_date INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('sale', 'purchase', 'transfer', 'bundling')),
  partner_id TEXT,
  our_company_id TEXT NOT NULL,
  manufacturer_id TEXT,
  warehouse_from_id TEXT,
  warehouse_to_id TEXT,
  shipment_scheme TEXT CHECK (shipment_scheme IN ('A', 'B', 'C') OR shipment_scheme IS NULL),
  shipper_id TEXT,
  order_doc_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'order_fulfilment', 'production', 'stocked', 'shipped', 'delivered', 'cancelled')),
  price_type_id TEXT,
  currency TEXT,
  fx_rate_to_usd INTEGER,
  total_amount INTEGER,
  total_usd_equiv INTEGER,
  incoterms TEXT,
  hs_code TEXT,
  lead_time_days INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  reference TEXT,
  contract_id TEXT REFERENCES contracts(id),
  default_document_language TEXT CHECK (default_document_language IN ('EN', 'RU', 'BILINGUAL') OR default_document_language IS NULL),
  dei_layer INTEGER NOT NULL DEFAULT 0 CHECK (dei_layer IN (0,1)),
  legal_seller_id TEXT REFERENCES manufacturers(id),
  vat_rate INTEGER NOT NULL DEFAULT 0 CHECK (vat_rate IN (0, 5, 20)),
  receiving_company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT,
  via_dei INTEGER NOT NULL DEFAULT 0 CHECK (via_dei IN (0, 1)),
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (our_company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_from_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_to_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (shipper_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id) REFERENCES price_types(id) ON DELETE RESTRICT
);

-- Step 3: copy all existing data
INSERT INTO operations SELECT * FROM operations_old;

-- Step 4: drop old table
DROP TABLE operations_old;

-- Step 5: recreate indexes
CREATE INDEX IF NOT EXISTS idx_operations_partner    ON operations(partner_id);
CREATE INDEX IF NOT EXISTS idx_operations_contract   ON operations(contract_id);
CREATE INDEX IF NOT EXISTS idx_operations_status     ON operations(status);
CREATE INDEX IF NOT EXISTS idx_operations_type       ON operations(operation_type);
CREATE INDEX IF NOT EXISTS idx_operations_date       ON operations(operation_date);

-- Step 6: bundling_items table
-- Each row = one pack/unpack pair within a bundling operation.
-- from_product_id: SKU being consumed (e.g. de201 in pack, de201aa in unpack)
-- to_product_id:   SKU being produced (e.g. de201aa in pack, de201 in unpack)
-- from_qty:        units consumed
-- to_qty:          units produced (from_qty / ratio for pack, from_qty * ratio for unpack)
-- direction:       'pack' (singles → bundle) | 'unpack' (bundle → singles)
CREATE TABLE bundling_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  from_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  to_product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  from_qty        INTEGER NOT NULL CHECK (from_qty > 0),
  to_qty          INTEGER NOT NULL CHECK (to_qty > 0),
  direction       TEXT NOT NULL CHECK (direction IN ('pack', 'unpack')),
  warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bundling_items_op ON bundling_items(operation_id);

-- Step 7: add BND sequence for reference numbers
INSERT OR IGNORE INTO sequences (id, prefix, next_number, pad_length, created_at, updated_at)
VALUES ('seq_bnd', 'BND', 1, 3, unixepoch(), unixepoch());

PRAGMA foreign_keys = ON;
