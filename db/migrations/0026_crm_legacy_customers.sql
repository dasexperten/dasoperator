-- Phase 8.x — CRM legacy customers from Yandex KIT export
-- Applied to D1 prod via REST API on 2026-05-09.
--
-- Source of truth for clients who shopped via Yandex KIT before
-- 2026-04-21 (when Retail CRM was connected). Stored separately from
-- live Retail CRM data so we can keep both views without conflict.
--
-- Schema mirrors Yandex KIT CSV columns:
--   № клиента, Имя, Телефон, Email, Согласие на email рассылку,
--   Время и дата получения согласия, Дата регистрации, Заказов,
--   Сумма заказов, Дата создания последнего завершенного заказа,
--   Заметка
--
-- Loaded once via /admin/seed-legacy-customers endpoint; subsequent
-- exports replace existing rows by external_id.

CREATE TABLE IF NOT EXISTS crm_legacy_customers (
  id                       TEXT PRIMARY KEY,           -- prefix legacy_ + external_id
  external_id              INTEGER NOT NULL UNIQUE,    -- "№ клиента" from Yandex
  name                     TEXT NOT NULL,
  phone                    TEXT,
  email                    TEXT,
  email_consent            INTEGER NOT NULL DEFAULT 0, -- 0/1 (Да/Нет)
  email_consent_at         TEXT,                       -- as printed in CSV
  registered_at            TEXT,                       -- DD.MM.YYYY format kept
  orders_count             INTEGER NOT NULL DEFAULT 0,
  total_spent              INTEGER NOT NULL DEFAULT 0, -- in kopecks (multiply by 100)
  last_completed_order_at  TEXT,
  note                     TEXT,
  source                   TEXT NOT NULL DEFAULT 'yandex_kit',
  imported_at              INTEGER NOT NULL,
  imported_from_file       TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  deleted_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_legacy_customers_phone
  ON crm_legacy_customers(phone) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_legacy_customers_email
  ON crm_legacy_customers(email) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_legacy_customers_registered_at
  ON crm_legacy_customers(registered_at) WHERE deleted_at IS NULL;
