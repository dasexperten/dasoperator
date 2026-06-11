-- Phase 10.1 — Loyalty redemptions: списание баллов через персональные промокоды KIT
-- Код = DAS-XXXX-XX, one_time_use, VALUE = сумма списания, minimum_order_amount = 2×сумма
-- (автоматически обеспечивает правило «до 50% заказа»), TTL 48 часов.
-- Неиспользованный истёкший код → возврат баллов (reconcile).

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id                TEXT PRIMARY KEY,             -- 'lr_' + uuid
  account_id        TEXT NOT NULL REFERENCES loyalty_accounts(id),
  tx_id             TEXT NOT NULL,                -- loyalty_transactions.id (redemption, −amount)
  code              TEXT NOT NULL UNIQUE,         -- DAS-XXXX-XX
  kit_promocode_id  TEXT,                         -- uuid промокода в KIT
  amount            INTEGER NOT NULL,             -- ₽ скидки = списанные баллы
  status            TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','used','refunded')),
  delivery          TEXT,                         -- email-адрес доставки кода (masked в API)
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_open
  ON loyalty_redemptions(status, expires_at) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_account
  ON loyalty_redemptions(account_id, created_at);
