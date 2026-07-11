-- Phase 12.1 — Website carts: dasexperten.com abandoned-checkout capture
-- Source of carts: Stripe checkout Worker `dasexperten-checkout`. It POSTs an
-- "initiated" cart at the /quote step — the moment the shopper has entered a
-- shipping address and a delivery agent is being chosen, so email + recipient
-- + line items + the NSS draft order_number are all known — to
--   POST /api/crm/website/cart
-- On payment success the matching order (ingestPaymentIntent) flips the cart to
-- 'converted'; the hourly poller sweeps stale 'initiated' carts to 'abandoned'.
-- Join key = order_number (the NSS draft number, identical to
-- crm_orders.order_number for website orders).
--
-- Money is INTEGER minor units (cents); dates are INTEGER unix seconds —
-- same conventions as 0060_crm_website.sql.

CREATE TABLE IF NOT EXISTS crm_carts (
  id                    TEXT PRIMARY KEY,            -- 'cart_' + uuid
  order_number          TEXT NOT NULL UNIQUE,        -- NSS draft number (join to crm_orders)
  status                TEXT NOT NULL DEFAULT 'initiated'
                        CHECK (status IN ('initiated','converted','abandoned','recovered')),
  email                 TEXT,
  phone                 TEXT,
  customer_name         TEXT,
  ship_country          TEXT,
  ship_city             TEXT,
  lang                  TEXT,
  currency              TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents        INTEGER NOT NULL DEFAULT 0,
  items                 TEXT,                        -- JSON [{sku,name,qty}]
  stripe_payment_intent TEXT,                        -- set when the cart converts
  initiated_at          INTEGER NOT NULL,            -- first /quote for this draft
  converted_at          INTEGER,                     -- payment_intent.succeeded epoch
  abandoned_at          INTEGER,                     -- sweep / superseded epoch
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_carts_status ON crm_carts(status, initiated_at);
CREATE INDEX IF NOT EXISTS idx_crm_carts_email  ON crm_carts(email);
