-- Зеркало заказов русской витрины в D1 — слой 3 (Владелец 2026-08-29,
-- BACKLOGS/2026-08-29_crm-orders-d1-mirror.md).
--
-- Экран CRM → Orders читает ЭТИ таблицы, а не живую ленту dasexperten.ru.
-- Витрина остаётся источником истины; с ней общается синхронизатор
-- (api/src/lib/crm-orders-sync.ts), не палец Владельца на кнопке.
--
-- Персональных данных здесь нет и не будет: ни имени, ни телефона, ни почты.
-- customer_key — необратимый SHA-256 с солью, как отдаёт витрина (ст. 12 152-ФЗ,
-- тот же режим, что у ленты). Строки никогда не удаляются целиком: заказ,
-- исчезнувший из ленты, остаётся — иначе total_count на экране прыгает.

CREATE TABLE IF NOT EXISTS crm_orders_ru (
  order_number   TEXT PRIMARY KEY,           -- DE260828-0854 — публичный номер витрины
  storefront_id  TEXT,                       -- внутренний id витрины (строкой, как в ленте)
  status         TEXT    NOT NULL,           -- словарь витрины в форме КИТ: NEW · PROCESSING · DELIVERY · COMPLETED · CANCELLED
  created_at     TEXT    NOT NULL,           -- ISO8601 как отдаёт витрина
  total_rub      INTEGER NOT NULL DEFAULT 0, -- итог к оплате, рубли целиком (лента даёт строку "379.00")
  subtotal_rub   INTEGER NOT NULL DEFAULT 0, -- до скидок/доставки
  paid           INTEGER NOT NULL DEFAULT 0, -- 1 если payment.status = PAYMENT_FINALLY_PAID
  units          INTEGER NOT NULL DEFAULT 0, -- штук в заказе
  customer_key   TEXT,                       -- необратимый ключ покупателя; НЕ телефон
  raw_json       TEXT,                       -- позиция ленты как пришла — для будущих колонок без пересинка
  first_seen_at  INTEGER NOT NULL,           -- unix, когда строка появилась в зеркале
  synced_at      INTEGER NOT NULL            -- unix, когда строка последний раз обновлена из ленты
);

CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_created  ON crm_orders_ru(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_status   ON crm_orders_ru(status);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_total    ON crm_orders_ru(total_rub);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_customer ON crm_orders_ru(customer_key);

-- Состояние синка: одна строка на ленту. data_as_of на экране = last_ok_at,
-- никогда не Date.now(). Плашка stale — если last_ok_at старше 3 часов.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  feed           TEXT PRIMARY KEY,   -- 'orders_ru'
  last_ok_at     INTEGER,            -- unix последнего удачного синка
  last_try_at    INTEGER,            -- unix последней попытки, удачной или нет
  last_error     TEXT,               -- текст причины последнего сбоя; NULL после удачи
  last_total     INTEGER,            -- total_count ленты при последнем удачном синке
  last_upserted  INTEGER             -- сколько строк записано в последнем удачном синке
);

INSERT OR IGNORE INTO crm_sync_state (feed) VALUES ('orders_ru');
