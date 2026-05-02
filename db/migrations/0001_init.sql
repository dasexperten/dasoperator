-- =============================================================================
-- Das Operator ERP — Initial Schema Migration (Phase 1.1)
-- =============================================================================
-- Creates all 16 tables with indexes, CHECK constraints, and FK relationships.
--
-- How to apply via D1 Console:
-- 1. dash.cloudflare.com -> Workers & Pages -> D1 -> das_erp_dev
-- 2. Click Console tab
-- 3. Paste this entire file
-- 4. Click Execute
-- 5. Verify: SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- COMPANIES — наши юрлица (DEE, DEI, DEASEAN, DEC)
-- -----------------------------------------------------------------------------
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  abbreviation TEXT NOT NULL UNIQUE,
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  jurisdiction TEXT,
  registration_no TEXT,
  tax_id TEXT,
  registered_address TEXT,
  base_currency TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_companies_abbreviation ON companies(abbreviation);

-- -----------------------------------------------------------------------------
-- MANUFACTURERS — производители (WDAA, Meizhiyuan, Yangzhou Jinxia)
-- -----------------------------------------------------------------------------
CREATE TABLE manufacturers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  city TEXT,
  address TEXT,
  role TEXT,
  bank_notes TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- -----------------------------------------------------------------------------
-- PRICE_TYPES — типы прайсов
-- -----------------------------------------------------------------------------
CREATE TABLE price_types (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  currency TEXT NOT NULL,
  used_by_entity TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- PRODUCTS — каталог SKU
-- -----------------------------------------------------------------------------
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  invoice_label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Toothpaste', 'Toothbrush', 'Floss', 'Other')),
  barcode TEXT,
  weight_kg INTEGER,
  volume_m3_micro INTEGER,
  manufacturer_id TEXT NOT NULL,
  buy_price INTEGER,
  buy_currency TEXT,
  buy_term TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE RESTRICT
);
CREATE INDEX idx_products_manufacturer ON products(manufacturer_id);
CREATE INDEX idx_products_category ON products(category);

-- -----------------------------------------------------------------------------
-- PRODUCT_PRICES — junction таблица SKU x PriceType
-- -----------------------------------------------------------------------------
CREATE TABLE product_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  price_type_id TEXT NOT NULL,
  sell_price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_until INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id) REFERENCES price_types(id) ON DELETE RESTRICT
);
CREATE INDEX idx_prices_product ON product_prices(product_id);
CREATE INDEX idx_prices_type ON product_prices(price_type_id);

-- -----------------------------------------------------------------------------
-- PARTNERS — контрагенты (buyers, suppliers, shippers)
-- -----------------------------------------------------------------------------
CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  trade_name TEXT NOT NULL,
  legal_name TEXT,
  country TEXT,
  tax_id TEXT,
  iban TEXT,
  swift_bic TEXT,
  bank_name TEXT,
  linked_entity_id TEXT,
  price_type_id TEXT,
  currency TEXT,
  contract_no TEXT,
  contract_date INTEGER,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked', 'pending')),
  partner_type TEXT NOT NULL CHECK (partner_type IN ('buyer', 'supplier', 'shipper', 'other')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (linked_entity_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id) REFERENCES price_types(id) ON DELETE RESTRICT
);
CREATE INDEX idx_partners_entity ON partners(linked_entity_id);
CREATE INDEX idx_partners_type ON partners(partner_type);
CREATE INDEX idx_partners_status ON partners(status);

-- -----------------------------------------------------------------------------
-- WAREHOUSES — склады
-- -----------------------------------------------------------------------------
CREATE TABLE warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT,
  city TEXT,
  warehouse_type TEXT CHECK (warehouse_type IN ('internal', 'external', 'bonded', 'factory', '3pl') OR warehouse_type IS NULL),
  owner_id TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES partners(id) ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- SHIPPERS — логисты
-- -----------------------------------------------------------------------------
CREATE TABLE shippers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  trade_name TEXT NOT NULL,
  legal_name TEXT,
  country TEXT,
  modes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cold_lead', 'warm_lead', 'inactive')),
  last_verified INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- -----------------------------------------------------------------------------
-- STOCKS — остатки SKU x Warehouse
-- -----------------------------------------------------------------------------
CREATE TABLE stocks (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_units INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  UNIQUE(warehouse_id, product_id)
);
CREATE INDEX idx_stocks_warehouse ON stocks(warehouse_id);
CREATE INDEX idx_stocks_product ON stocks(product_id);

-- -----------------------------------------------------------------------------
-- OPERATIONS — Sale / Purchase / Transfer
-- -----------------------------------------------------------------------------
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  operation_date INTEGER NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('sale', 'purchase', 'transfer')),
  partner_id TEXT,
  our_company_id TEXT NOT NULL,
  manufacturer_id TEXT,
  warehouse_from_id TEXT,
  warehouse_to_id TEXT,
  shipment_scheme TEXT CHECK (shipment_scheme IN ('A', 'B', 'C') OR shipment_scheme IS NULL),
  shipper_id TEXT,
  order_doc_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'order_fulfilment', 'production', 'shipped', 'delivered', 'cancelled')),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
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
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (our_company_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (manufacturer_id) REFERENCES manufacturers(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_from_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_to_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  FOREIGN KEY (shipper_id) REFERENCES partners(id) ON DELETE RESTRICT,
  FOREIGN KEY (price_type_id) REFERENCES price_types(id) ON DELETE RESTRICT
);
CREATE INDEX idx_operations_date ON operations(operation_date);
CREATE INDEX idx_operations_type ON operations(operation_type);
CREATE INDEX idx_operations_status ON operations(status);
CREATE INDEX idx_operations_partner ON operations(partner_id);

-- -----------------------------------------------------------------------------
-- LINE_ITEMS — позиции внутри Operation
-- -----------------------------------------------------------------------------
CREATE TABLE line_items (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  item_description TEXT,
  qty INTEGER NOT NULL,
  cartons INTEGER NOT NULL DEFAULT 0,
  inner_boxes INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL,
  discount_pct INTEGER NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  unit_price_after_disc INTEGER NOT NULL,
  line_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  line_usd_equiv INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);
CREATE INDEX idx_line_items_operation ON line_items(operation_id);
CREATE INDEX idx_line_items_product ON line_items(product_id);

-- -----------------------------------------------------------------------------
-- DOCUMENTS — реестр CI / PL / контрактов
-- -----------------------------------------------------------------------------
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  document_number TEXT NOT NULL UNIQUE,
  document_type TEXT NOT NULL CHECK (document_type IN ('CI', 'PL', 'IS', 'contract', 'annex', 'addendum', 'other')),
  operation_id TEXT,
  issuer_id TEXT NOT NULL,
  partner_id TEXT,
  contract_ref TEXT,
  document_date INTEGER NOT NULL,
  currency TEXT,
  total_amount INTEGER,
  pdf_r2_url TEXT,
  owner_name TEXT,
  mandatory_level TEXT CHECK (mandatory_level IN ('mandatory', 'important', 'on_request') OR mandatory_level IS NULL),
  when_ready TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE RESTRICT,
  FOREIGN KEY (issuer_id) REFERENCES companies(id) ON DELETE RESTRICT,
  FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE RESTRICT
);
CREATE INDEX idx_documents_operation ON documents(operation_id);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_number ON documents(document_number);

-- -----------------------------------------------------------------------------
-- INVENTORY_SESSIONS — сессии инвентаризации
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_sessions (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  inventory_date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'applied', 'cancelled')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
);

-- -----------------------------------------------------------------------------
-- INVENTORY_ITEMS — позиции в сессии инвентаризации
-- -----------------------------------------------------------------------------
CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  expected_qty INTEGER NOT NULL,
  counted_qty INTEGER,
  delta_qty INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);
CREATE INDEX idx_inventory_items_session ON inventory_items(session_id);

-- -----------------------------------------------------------------------------
-- SEQUENCES — счётчики для генерации DEI-001, CI-202605-0001 и т.д.
-- -----------------------------------------------------------------------------
CREATE TABLE sequences (
  id TEXT PRIMARY KEY,
  description TEXT,
  next_number INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 3,
  format_example TEXT,
  updated_at INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- FX_RATES — курсы валют по дням
-- -----------------------------------------------------------------------------
CREATE TABLE fx_rates (
  id TEXT PRIMARY KEY,
  rate_date INTEGER NOT NULL,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate INTEGER NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(rate_date, from_currency, to_currency)
);
CREATE INDEX idx_fx_rates_date ON fx_rates(rate_date);
CREATE INDEX idx_fx_rates_pair ON fx_rates(from_currency, to_currency);

-- =============================================================================
-- END OF MIGRATION 0001_init.sql
-- After execution, run this verification:
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- Expected output: 16 tables
-- =============================================================================
