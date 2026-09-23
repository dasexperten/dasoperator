-- 0101 — durable, non-personal commerce attribution on website orders.
--
-- These fields are copied from bounded Stripe PaymentIntent metadata. They do
-- not contain buyer identity, URL query strings or referrers. Pinterest is the
-- first supported source; the neutral schema leaves room for other verified
-- sources without overloading crm_orders.source (website/wix/manual).

ALTER TABLE crm_orders ADD COLUMN traffic_source   TEXT;
ALTER TABLE crm_orders ADD COLUMN traffic_medium   TEXT;
ALTER TABLE crm_orders ADD COLUMN traffic_campaign TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_orders_traffic_source
  ON crm_orders(traffic_source, placed_at DESC);
