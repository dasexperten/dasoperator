-- WB library: lasting day-by-day history per product (Owner 2026-10-10).
-- marketplace_sales_wb is a 7-day snapshot replaced every night; this table keeps
-- every day. One row per Moscow calendar day and product. Each source writes only
-- its own columns, so a failed source never erases another: NULL = not received yet,
-- never zero. Money in kopecks.
CREATE TABLE IF NOT EXISTS wb_sku_daily (
  date              TEXT NOT NULL,     -- YYYY-MM-DD, WB (Moscow) day
  base_sku          TEXT NOT NULL,     -- products.id, lowercase
  units_sold        INTEGER,           -- WB statistics sales rows that day
  revenue_kopecks   INTEGER,           -- sum of priceWithDisc
  views             INTEGER,           -- sales funnel: card opens
  tocart            INTEGER,           -- sales funnel: add to cart
  orders            INTEGER,           -- sales funnel: orders
  price_kopecks     INTEGER,           -- seller price after discount, read the next morning
  ad_spend_kopecks  INTEGER,           -- advertising fullstats spend that day
  sales_synced_at   INTEGER,
  funnel_synced_at  INTEGER,
  price_synced_at   INTEGER,
  ad_synced_at      INTEGER,
  PRIMARY KEY (date, base_sku)
);
CREATE INDEX IF NOT EXISTS wb_sku_daily_sku ON wb_sku_daily(base_sku, date);
