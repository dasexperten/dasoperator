-- 0073 · Portal order confirmation (Owner 2026-08-14)
--
-- A cabinet order is a draft until one person confirms it, and that person is the
-- Owner. Until now nothing recorded the confirmation: the operation sat at
-- 'draft' and moving it was a hand in the ERP with no trail, no link from the
-- letter, and no notification back to the partner.
--
-- These columns hold the trail. The token is never stored — only its SHA-256,
-- the same shape already used for portal_accounts.reset_token_hash and for the
-- lead approval link, so a guessed or edited link is refused.

ALTER TABLE portal_orders ADD COLUMN confirm_status TEXT NOT NULL DEFAULT 'awaiting'
  CHECK (confirm_status IN ('awaiting','confirmed','changes_requested','cancelled'));

ALTER TABLE portal_orders ADD COLUMN confirm_token_hash TEXT;
ALTER TABLE portal_orders ADD COLUMN confirm_expires_at INTEGER;

ALTER TABLE portal_orders ADD COLUMN confirmed_by TEXT;      -- who pressed: 'owner' | 'lauda'
ALTER TABLE portal_orders ADD COLUMN confirmed_at INTEGER;

ALTER TABLE portal_orders ADD COLUMN partner_notified_at INTEGER;
ALTER TABLE portal_orders ADD COLUMN invoice_r2_key TEXT;    -- the pro forma sent to the partner
ALTER TABLE portal_orders ADD COLUMN logistics_notified_at INTEGER;  -- the same document to Zina

CREATE INDEX IF NOT EXISTS idx_portal_orders_confirm_status
  ON portal_orders (confirm_status, submitted_at DESC);
