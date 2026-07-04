-- Migration 0058: FBO supply planning — cluster-grain data layer.
-- Idempotent: safe to re-run.

-- 1. Warehouse → cluster map (needed for WB; Ozon reports cluster natively).
--    Rows with cluster = 'UNKNOWN' are inserted by sync when it meets a new
--    warehouse; Aram reviews and fills them. Calc flags UNKNOWN rows and
--    excludes them from to_ship.
CREATE TABLE IF NOT EXISTS fbo_cluster_map (
  marketplace     TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wb')),
  warehouse_name  TEXT NOT NULL,
  cluster         TEXT NOT NULL DEFAULT 'UNKNOWN',
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (marketplace, warehouse_name)
);

-- Seed: only mappings confirmed in the April 2026 methodology session.
-- Everything else arrives as UNKNOWN from sync and is reviewed manually.
INSERT OR IGNORE INTO fbo_cluster_map (marketplace, warehouse_name, cluster, updated_at) VALUES
  ('wb', 'Коледино',                        'Центральный',      unixepoch()),
  ('wb', 'Электросталь',                    'Центральный',      unixepoch()),
  ('wb', 'Подольск',                        'Центральный',      unixepoch()),
  ('wb', 'Тула',                            'Центральный',      unixepoch()),
  ('wb', 'Краснодар',                       'Южный',            unixepoch()),
  ('wb', 'СЦ Краснодар',                    'Южный',            unixepoch()),
  ('wb', 'Санкт-Петербург Шушары',          'Северо-Западный',  unixepoch()),
  ('wb', 'Санкт-Петербург Уткина Заводь',   'Северо-Западный',  unixepoch()),
  ('wb', 'Екатеринбург - Перспективный 14', 'Восточный',        unixepoch()),
  ('wb', 'Екатеринбург - Испытателей 14г',  'Восточный',        unixepoch());

-- 2. Stocks at (marketplace, sku, cluster) grain.
--    Written by cron sync: Ozon hourly, WB every 4 hours.
--    Full rewrite per marketplace per run (DELETE + INSERT in sync code) —
--    snapshot semantics, no history here. base_sku follows the existing
--    lowercase convention of marketplace_stocks_* (de201, de101aa, ...).
CREATE TABLE IF NOT EXISTS fbo_stocks_cluster (
  marketplace  TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wb')),
  base_sku     TEXT NOT NULL,
  cluster      TEXT NOT NULL,
  units        INTEGER NOT NULL DEFAULT 0,
  synced_at    INTEGER NOT NULL,
  PRIMARY KEY (marketplace, base_sku, cluster)
);

-- 3. Sales for the trailing 30-day window at the same grain.
--    WB: returns (saleID starting with R) are excluded upstream in sync.
--    Ozon: paid-storage SKU exclusions are applied in calc, not here —
--    raw sales stay unfiltered so the number is auditable.
CREATE TABLE IF NOT EXISTS fbo_sales_cluster (
  marketplace  TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wb')),
  base_sku     TEXT NOT NULL,
  cluster      TEXT NOT NULL,
  units_30d    INTEGER NOT NULL DEFAULT 0,
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  synced_at    INTEGER NOT NULL,
  PRIMARY KEY (marketplace, base_sku, cluster)
);

-- 4. Run log for the FBO recalc itself (feeds the status panel that
--    replaces the old GitHub Actions runs block on /marketplaces).
CREATE TABLE IF NOT EXISTS fbo_calc_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace   TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wb')),
  run_date      TEXT NOT NULL,
  sku_count     INTEGER NOT NULL DEFAULT 0,
  stocks_rows   INTEGER NOT NULL DEFAULT 0,
  sales_rows    INTEGER NOT NULL DEFAULT 0,
  to_ship_units INTEGER NOT NULL DEFAULT 0,
  to_ship_count INTEGER NOT NULL DEFAULT 0,
  oos_count     INTEGER NOT NULL DEFAULT 0,
  overstock_count INTEGER NOT NULL DEFAULT 0,
  unknown_cluster_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error_message TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fbo_calc_runs_mp_date
  ON fbo_calc_runs (marketplace, created_at DESC);
