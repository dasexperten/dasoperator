-- Phase 10.0 — Loyalty Engine (замена RetailCRM)
-- Spec: CoWork/PROJECTS/loyalty-program/kit-loyalty-engine-spec.md
-- Программа «Клуб Экспертов»: Свой 0₽/5% → Ценитель 10к/10% → Эксперт 25к/15% → Амбассадор 50к/20%
-- 1 балл = 1 ₽. Hold начисления 7 дней после доставки. Жизнь баллов 12 мес от активности.
-- Источник заказов: Yandex KIT API (вебхук ORDER_STATUS_CHANGED → /api/loyalty/webhook/kit).

CREATE TABLE IF NOT EXISTS loyalty_accounts (
  id               TEXT PRIMARY KEY,              -- 'la_' + uuid
  phone            TEXT NOT NULL UNIQUE,          -- normalized E.164, ключ счёта
  email            TEXT,
  name             TEXT,
  kit_customer_id  TEXT,                          -- customer_id из KIT (uuid)
  balance          INTEGER NOT NULL DEFAULT 0,    -- активные баллы (1 балл = 1 ₽)
  pending_balance  INTEGER NOT NULL DEFAULT 0,    -- баллы на 7-дневном hold
  lifetime_spent   INTEGER NOT NULL DEFAULT 0,    -- ₽ товаров (без доставки), копится для уровня
  tier             TEXT NOT NULL DEFAULT 'svoy' CHECK (tier IN ('svoy','tsenitel','expert','ambassador')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  source           TEXT NOT NULL DEFAULT 'kit',   -- kit | retailcrm_migration | manual
  registered_at    INTEGER,
  last_activity_at INTEGER,                       -- продлевает жизнь баллов (12 мес)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_kit_customer
  ON loyalty_accounts(kit_customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_accounts_email
  ON loyalty_accounts(email);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id               TEXT PRIMARY KEY,              -- 'lt_' + uuid
  account_id       TEXT NOT NULL REFERENCES loyalty_accounts(id),
  type             TEXT NOT NULL CHECK (type IN ('accrual','redemption','welcome','birthday','burn','adjust','migration')),
  points           INTEGER NOT NULL,              -- signed: + начисление, − списание
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','cancelled','burned')),
  kit_order_id     TEXT,                          -- uuid заказа KIT
  kit_order_number INTEGER,
  order_amount     INTEGER,                       -- ₽ товаров, на которые начислено
  cashback_percent REAL,
  hold_until       INTEGER,                       -- unixtime окончания hold (pending → active)
  note             TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- идемпотентность: одно начисление на заказ
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_tx_one_accrual_per_order
  ON loyalty_transactions(kit_order_id) WHERE type = 'accrual';
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_account
  ON loyalty_transactions(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_pending
  ON loyalty_transactions(status, hold_until) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS loyalty_webhook_log (
  id           TEXT PRIMARY KEY,                  -- 'lw_' + uuid
  kit_order_id TEXT,
  event_type   TEXT,
  payload      TEXT,                              -- raw JSON body
  result       TEXT,                              -- processed | skipped:<reason> | error:<msg>
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_webhook_order
  ON loyalty_webhook_log(kit_order_id, created_at);
