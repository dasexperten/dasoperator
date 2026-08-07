-- Migration 0069: Wildberries FBS — declared stock per FBS warehouse + assembly tasks.
-- Idempotent: safe to re-run.
--
-- Context (Owner 2026-08-07): WB FBO warehouse strikes → the WB shopfront moves to FBS.
-- Seven FBS warehouses are registered in the seller cabinet. The ERP grows an accordion
-- next to the LBR column showing stock per FBS warehouse and incoming assembly tasks.
--
-- WHO WRITES THESE TABLES — read this before adding any code near them:
--   Both tables are written **only** by the fleet worker `arina-wb` (Arina Volkova),
--   on a 3h cron, from marketplace-api.wildberries.ru. `dasoperator-api` STORES and
--   DRAWS. It must not acquire an outbound call to WB for FBS.
--   Law: dasexperten/organizacia docs/MARKETPLACE_SPECIALIST_DATA_LAW.md
--        · agents/arina-volkova/FBS_TRANSITION.md (this migration's spec)
--
-- Grain note: both tables are snapshots/registries keyed on WB identifiers, not history.
-- Stocks are rewritten per warehouse per run (DELETE by warehouse_id + INSERT in the
-- worker) — same snapshot semantics as marketplace_stocks_wb. Orders accumulate and are
-- upserted by order_id so a status change does not create a second row.

-- 1. Declared stock per FBS warehouse.
--    `amount` = what WB believes sits at that warehouse (what we told it, as WB holds it).
--    The fulfilment partner's own WMS figure lives elsewhere (external_stocks, Zina's
--    lane) — the DIFFERENCE between the two is the point of the whole surface.
--    Absence of a WMS figure must render as "нет доступа" in the UI, never as 0.
CREATE TABLE IF NOT EXISTS marketplace_stocks_wb_fbs (
  warehouse_id   INTEGER NOT NULL,          -- WB FBS warehouseId (/api/v3/warehouses)
  office_id      INTEGER,                   -- WB officeId (pickup/handover point)
  warehouse_name TEXT,                      -- name as it reads in the seller cabinet
  barcode        TEXT    NOT NULL,          -- WB skus barcode — the key WB stocks speak
  vendor_code    TEXT,                      -- our supplierArticle, e.g. DE206AA
  product_id     TEXT,                      -- lowercased sku, joins products.id (de206aa)
  amount         INTEGER NOT NULL DEFAULT 0,
  synced_at      INTEGER NOT NULL,          -- unixepoch of the pull that wrote this row
  PRIMARY KEY (warehouse_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_wb_fbs_stocks_product
  ON marketplace_stocks_wb_fbs (product_id);
CREATE INDEX IF NOT EXISTS idx_wb_fbs_stocks_synced
  ON marketplace_stocks_wb_fbs (synced_at);

-- 2. FBS assembly tasks (сборочные задания).
--    deliver_by is the assembly deadline. The cadence is 3h by Owner ruling
--    (2026-08-07), so the deadline must be VISIBLE rather than out-polled: the UI ranks
--    by time left and reddens the last window. A missed deadline is a logged incident.
--
--    price_cents holds WB convertedPrice — a SHOPFRONT figure. It is NOT what the buyer
--    paid. Paid buyer price comes only from the weekly WB realization report
--    (HARD_RULES / DATA_LAW §9). Do not sum this column and call it revenue; the UI does
--    not render it at all (Owner surface decision 2026-08-07).
CREATE TABLE IF NOT EXISTS wb_fbs_orders (
  order_id       INTEGER PRIMARY KEY,       -- WB assembly task id
  rid            TEXT,                      -- WB rid (order line reference)
  warehouse_id   INTEGER NOT NULL,
  office_id      INTEGER,
  nm_id          INTEGER,
  vendor_code    TEXT,
  product_id     TEXT,                      -- lowercased sku, joins products.id
  barcode        TEXT,
  price_cents    INTEGER,                   -- convertedPrice, витрина only — never "paid"
  created_at     INTEGER NOT NULL,          -- WB createdAt
  deliver_by     INTEGER,                   -- assembly deadline
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','confirm','complete','cancel','deliver','receive','sold')),
  status_at      INTEGER,
  synced_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb_fbs_orders_wh
  ON wb_fbs_orders (warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_wb_fbs_orders_due
  ON wb_fbs_orders (deliver_by);
CREATE INDEX IF NOT EXISTS idx_wb_fbs_orders_product
  ON wb_fbs_orders (product_id);

-- 3. Registry of our FBS warehouses, so the UI can draw the accordion (names, order,
--    and whether a WMS connector exists) without calling WB and without hardcoding
--    seven ids in the frontend.
--    wms_provider stays NULL until Zina lands a connector for that partner. NULL is the
--    signal for "нет доступа" in the delta column — the honest blank, not a zero.
CREATE TABLE IF NOT EXISTS wb_fbs_warehouses (
  warehouse_id   INTEGER PRIMARY KEY,
  office_id      INTEGER,
  name           TEXT NOT NULL,
  short_name     TEXT,                      -- column label in the accordion
  cargo_type     INTEGER,
  delivery_type  INTEGER,
  wms_provider   TEXT,                      -- 'skladbot' | '1c' | ... | NULL = no access
  wms_warehouse_id TEXT,                    -- id of this warehouse inside that WMS
  is_active      INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 100,
  synced_at      INTEGER NOT NULL
);

-- Seed: the seven warehouses live in the cabinet as read on 2026-08-07 via
-- GET https://marketplace-api.wildberries.ru/api/v3/warehouses.
-- INSERT OR IGNORE — the worker refreshes names/flags on each run, so a rename in the
-- cabinet propagates without a migration. wms_provider is left to Zina's lane.
INSERT OR IGNORE INTO wb_fbs_warehouses
  (warehouse_id, office_id, name, short_name, cargo_type, delivery_type, sort_order, synced_at) VALUES
  (1152433, 3105447, 'FBS Москва (Обухово) Сенин Игорь', 'Москва',      1, 1, 10, unixepoch()),
  (1201287,   10999, 'Питер FBS Шушары (Григор)',        'СПб',         1, 1, 20, unixepoch()),
  (1201196, 3088703, 'Казань FBS Царицино',              'Казань',      1, 1, 30, unixepoch()),
  (1186473,      30, 'Краснодар Краеведа Соловьёва 6к2', 'Краснодар',   1, 1, 40, unixepoch()),
  (1152645,   10220, 'FBS Пенза',                        'Пенза',       1, 1, 50, unixepoch()),
  (1116577, 3090292, 'FUROR Екатеринбург',               'Екатеринбург',1, 1, 60, unixepoch()),
  (1134128, 3089389, 'FFBASE Новосибирск',               'Новосибирск', 1, 1, 70, unixepoch());
