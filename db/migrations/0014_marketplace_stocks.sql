-- Phase 6.0 — Marketplace stock snapshots from Ozon and Wildberries.
--
-- Multipack convention (Das Experten product line):
--   no suffix      = single unit
--   suffix AA      = pack of 2
--   suffix AAAA    = pack of 4
--
-- Aggregation to canonical SKU happens at read time:
--   sum(qty * pack_factor) WHERE base_sku = products.id

CREATE TABLE IF NOT EXISTS marketplace_stocks_ozon (
  offer_id        TEXT NOT NULL,        -- Ozon offer_id (= our marketplace article)
  product_id      INTEGER NOT NULL,     -- Ozon internal product_id
  base_sku        TEXT NOT NULL,        -- canonical SKU we map to (DE201)
  pack_factor     INTEGER NOT NULL CHECK (pack_factor IN (1, 2, 4)),
  fbo_available   INTEGER NOT NULL DEFAULT 0,
  fbo_reserved    INTEGER NOT NULL DEFAULT 0,
  fbs_available   INTEGER NOT NULL DEFAULT 0,
  synced_at       INTEGER NOT NULL,     -- unix timestamp of last sync
  PRIMARY KEY (offer_id)
);

CREATE INDEX IF NOT EXISTS idx_ozon_base_sku ON marketplace_stocks_ozon(base_sku);

CREATE TABLE IF NOT EXISTS marketplace_stocks_wb (
  supplier_article TEXT NOT NULL,       -- WB supplierArticle (= our marketplace article)
  nm_id           INTEGER NOT NULL,     -- WB internal nmId
  base_sku        TEXT NOT NULL,        -- canonical SKU we map to (DE201)
  pack_factor     INTEGER NOT NULL CHECK (pack_factor IN (1, 2, 4)),
  quantity        INTEGER NOT NULL DEFAULT 0,    -- available for sale
  in_way_to_client INTEGER NOT NULL DEFAULT 0,
  in_way_from_client INTEGER NOT NULL DEFAULT 0,
  quantity_full   INTEGER NOT NULL DEFAULT 0,
  synced_at       INTEGER NOT NULL,
  PRIMARY KEY (supplier_article)
);

CREATE INDEX IF NOT EXISTS idx_wb_base_sku ON marketplace_stocks_wb(base_sku);

-- Sync log — track each sync attempt for ops visibility.
CREATE TABLE IF NOT EXISTS marketplace_sync_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace     TEXT NOT NULL CHECK (marketplace IN ('ozon', 'wb')),
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  rows_synced     INTEGER,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_log_recent
  ON marketplace_sync_log(marketplace, started_at DESC);
