-- Phase 12.0 — Website CRM: dasexperten.com orders → customer database
-- Source of orders: Stripe checkout Worker `dasexperten-checkout` (.com/.de storefront).
-- Ingest: POST /api/crm/website/webhook/stripe (payment_intent.succeeded) +
--         hourly reconciliation poller against the Stripe API ("7 * * * *").
-- Storage: D1 = queryable CRM (this file); R2 `das-loyalty-customers` under crm/
--          keeps the raw JSON snapshot of every order + customer (ADR-001:
--          D1 holds operational data, R2 holds blobs, D1 stores the key).
-- Field model follows Wix Stores (order_number, recipient, line items) and
-- Shopify (financial/fulfillment status, marketing consent, tags, aggregates).
-- Money is INTEGER minor units (cents) — same convention as kopecks elsewhere.

CREATE TABLE IF NOT EXISTS crm_customers (
  id                TEXT PRIMARY KEY,                -- 'cust_' + uuid
  email             TEXT UNIQUE,                     -- lowercased; primary identity
  phone             TEXT,                            -- normalized E.164, secondary identity
  first_name        TEXT,
  last_name         TEXT,
  company           TEXT,
  -- default shipping address (Wix recipient / Shopify default_address)
  country_code      TEXT,
  state_code        TEXT,
  city              TEXT,
  zip               TEXT,
  address1          TEXT,
  address2          TEXT,
  lang              TEXT,                            -- storefront locale (en/de/ru/vi/…)
  marketing_consent INTEGER NOT NULL DEFAULT 0,      -- Shopify accepts_marketing / Wix subscribed
  tags              TEXT,                            -- JSON array of strings
  notes             TEXT,
  source            TEXT NOT NULL DEFAULT 'website'  -- website | wix | retailcrm | manual
                    CHECK (source IN ('website','wix','retailcrm','manual')),
  external_ids      TEXT,                            -- JSON {stripe_customer_id, wix_contact_id, wix_member_id, retailcrm_id}
  -- lifetime aggregates over WEBSITE orders only (backfilled sources keep their
  -- own historical counters inside external snapshot, see r2_key)
  orders_count      INTEGER NOT NULL DEFAULT 0,
  total_spent_cents INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  first_order_at    INTEGER,
  last_order_at     INTEGER,
  r2_key            TEXT,                            -- crm/customers/{id}.json snapshot
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_customers_phone  ON crm_customers(phone);
CREATE INDEX IF NOT EXISTS idx_crm_customers_source ON crm_customers(source);
CREATE INDEX IF NOT EXISTS idx_crm_customers_spent  ON crm_customers(total_spent_cents);

CREATE TABLE IF NOT EXISTS crm_orders (
  id                   TEXT PRIMARY KEY,             -- 'ord_' + uuid
  source               TEXT NOT NULL DEFAULT 'website'
                       CHECK (source IN ('website','wix','manual')),
  order_number         TEXT NOT NULL,                -- NSS/checkout number; Wix order number for backfill
  stripe_payment_intent TEXT,                        -- pi_… idempotency key for website orders
  customer_id          TEXT REFERENCES crm_customers(id),
  customer_name        TEXT,
  email                TEXT,
  phone                TEXT,
  currency             TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents       INTEGER NOT NULL DEFAULT 0,
  shipping_cents       INTEGER NOT NULL DEFAULT 0,
  discount_cents       INTEGER NOT NULL DEFAULT 0,
  tax_cents            INTEGER NOT NULL DEFAULT 0,
  total_cents          INTEGER NOT NULL DEFAULT 0,
  financial_status     TEXT NOT NULL DEFAULT 'paid'
                       CHECK (financial_status IN ('pending','paid','partially_refunded','refunded','failed')),
  fulfillment_status   TEXT NOT NULL DEFAULT 'submitted'
                       CHECK (fulfillment_status IN ('unfulfilled','submitted','shipped','delivered','cancelled')),
  payment_method       TEXT,                         -- card | apple_pay | google_pay | link | wix_payments
  lang                 TEXT,
  -- ship-to (Stripe pi.shipping / Wix recipient)
  ship_name            TEXT,
  ship_country         TEXT,
  ship_state           TEXT,
  ship_city            TEXT,
  ship_zip             TEXT,
  ship_address1        TEXT,
  ship_address2        TEXT,
  shipping_method      TEXT,                         -- NSS route name when known
  tracking_number      TEXT,
  tracking_url         TEXT,
  items                TEXT,                         -- JSON [{sku,name,qty,unit_cents,total_cents}]
  raw_r2_key           TEXT,                         -- crm/orders/{source}/{order_number}.json
  placed_at            INTEGER,                      -- payment success epoch
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- order numbers are unique per source (Wix history reuses small integers)
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_orders_source_number
  ON crm_orders(source, order_number);
-- one order per PaymentIntent — webhook + poller stay idempotent
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_orders_pi
  ON crm_orders(stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_orders_customer ON crm_orders(customer_id, placed_at);
CREATE INDEX IF NOT EXISTS idx_crm_orders_placed   ON crm_orders(placed_at);
CREATE INDEX IF NOT EXISTS idx_crm_orders_email    ON crm_orders(email);

-- mirror of loyalty_webhook_log for the Stripe ingest path
CREATE TABLE IF NOT EXISTS crm_webhook_log (
  id         TEXT PRIMARY KEY,                       -- 'cw_' + uuid
  source     TEXT NOT NULL DEFAULT 'stripe',
  event_type TEXT,
  ref        TEXT,                                   -- pi_… / order number
  payload    TEXT,                                   -- raw JSON body, truncated
  result     TEXT,                                   -- upserted | skipped:<reason> | error:<msg>
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_webhook_ref ON crm_webhook_log(ref, created_at);

-- poller cursors and backfill bookmarks
CREATE TABLE IF NOT EXISTS crm_sync_state (
  key        TEXT PRIMARY KEY,                       -- e.g. 'stripe:last_created'
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
