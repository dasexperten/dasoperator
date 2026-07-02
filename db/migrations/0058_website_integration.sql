-- Phase 12.0 — dasexperten website (Cloudflare Pages + Stripe) → ERP integration.
--
-- The storefront migrated off Wix to a Cloudflare Pages site (dasexperten.de,
-- with .com folding into it) whose checkout runs on Stripe Checkout Sessions
-- via the dasexperten-checkout Worker → NextSmartShip fulfillment.
--
-- This migration mirrors website orders into the ERP for visibility and SKU
-- reconciliation. It is a MIRROR, NOT bookkeeping: website revenue keeps its
-- single financial truth in the monthly bank-settlement operations
-- (DASCOM-YYYYMM, built by rebuildPriorMonthDasexpertenCom in
-- marketplace-pull.ts). Creating per-order sale operations here would
-- double-count revenue — the same rule cemented for Yandex Pay in
-- scheduled.ts. Per-order → line_items enrichment is a deliberate Phase-2
-- item, out of scope here.
--
-- Money is stored in MINOR units (USD cents), matching the ERP-wide
-- convention (see web/lib/money.ts). Stripe already returns integer cents,
-- so no decimal parsing is needed.

CREATE TABLE IF NOT EXISTS website_orders (
  id                TEXT PRIMARY KEY,             -- Stripe Checkout Session id (cs_...)
  source            TEXT NOT NULL DEFAULT 'stripe',
  number            TEXT,                         -- human-facing ref if present (payment_intent)
  created_date      INTEGER NOT NULL,             -- unix (session.created)
  updated_date      INTEGER NOT NULL,             -- unix (last seen state)
  status            TEXT,                         -- open | complete | expired
  payment_status    TEXT,                         -- paid | unpaid | no_payment_required
  fulfillment_status TEXT,                        -- reserved for NSS status (Phase 2)
  currency          TEXT NOT NULL DEFAULT 'USD',
  amount_subtotal   INTEGER NOT NULL DEFAULT 0,   -- cents
  amount_shipping   INTEGER NOT NULL DEFAULT 0,   -- cents
  amount_tax        INTEGER NOT NULL DEFAULT 0,   -- cents
  amount_discount   INTEGER NOT NULL DEFAULT 0,   -- cents
  amount_total      INTEGER NOT NULL DEFAULT 0,   -- cents
  buyer_email       TEXT,
  buyer_name        TEXT,
  ship_country      TEXT,
  payment_intent    TEXT,                         -- pi_... when paid
  raw_json          TEXT,
  synced_at         INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_website_orders_created ON website_orders(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_website_orders_payment ON website_orders(payment_status);

CREATE TABLE IF NOT EXISTS website_order_lines (
  id                TEXT PRIMARY KEY,             -- <order_id>_<idx>
  order_id          TEXT NOT NULL REFERENCES website_orders(id),
  stripe_price_id   TEXT,                         -- price_...
  stripe_product_id TEXT,                         -- prod_...
  sku_raw           TEXT,                         -- SKU as carried in Stripe metadata
  product_id        TEXT,                         -- products.id when matched, NULL = unmatched
  item_name         TEXT,
  qty               INTEGER NOT NULL DEFAULT 1,
  unit_amount       INTEGER NOT NULL DEFAULT 0,   -- cents
  line_total        INTEGER NOT NULL DEFAULT 0,   -- cents
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_website_lines_order ON website_order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_website_lines_unmatched ON website_order_lines(product_id) WHERE product_id IS NULL;

-- Catalog mirror: Stripe Products × Prices. Lets the ERP surface the live
-- price the storefront charges and reconcile it against product_prices.
CREATE TABLE IF NOT EXISTS website_products (
  stripe_price_id   TEXT PRIMARY KEY,             -- price_...
  stripe_product_id TEXT NOT NULL,                -- prod_...
  sku_raw           TEXT,                         -- metadata.sku
  product_id        TEXT,                         -- matched catalog SKU or NULL
  name              TEXT,
  unit_amount       INTEGER,                      -- cents
  currency          TEXT NOT NULL DEFAULT 'USD',
  active            INTEGER NOT NULL DEFAULT 1,
  synced_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_website_products_sku ON website_products(product_id);

-- Incremental-sync bookmark (e.g. 'orders_watermark' = last created_date processed).
CREATE TABLE IF NOT EXISTS website_sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);

-- Dedicated sync log. marketplace_sync_log (0014) has a CHECK constraint
-- limiting marketplace to 'ozon'/'wb', and D1 cannot ALTER a CHECK in place,
-- so website runs get their own log table with the same shape + semantics.
CREATE TABLE IF NOT EXISTS website_sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('orders', 'catalog')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  rows_synced   INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_website_sync_log_recent ON website_sync_log(kind, started_at DESC);
