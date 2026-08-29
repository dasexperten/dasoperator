-- Зеркало заказов .ru: оплата Т-Кассы и доставка Ozon (Владелец 2026-08-29:
-- «обязательно, чтобы учитывались заказы оплаты и доставки»).
--
-- Лента витрины v2 (site/ru/server/api/erp/orders.php) с 29.08 отдаёт сырой
-- статус витрины, paid_at и служебные поля доставки. Усечённый до КИТ статус
-- склеивал paid и delivered в COMPLETED — эти колонки размыкают склейку.
--
-- Персональных данных по-прежнему нет: адрес ПВЗ, город, имя и телефон
-- получателя в ленту не входят и сюда не попадают.

ALTER TABLE crm_orders_ru ADD COLUMN storefront_status  TEXT;    -- new · awaiting_payment · paid · payment_failed · packing · shipped · delivered · cancelled · refunded
ALTER TABLE crm_orders_ru ADD COLUMN source             TEXT;    -- site | kit
ALTER TABLE crm_orders_ru ADD COLUMN updated_at         TEXT;    -- ISO8601 витрины, последнее изменение заказа
ALTER TABLE crm_orders_ru ADD COLUMN paid_at            TEXT;    -- ISO8601, момент подтверждения Т-Кассы; NULL — не оплачен
ALTER TABLE crm_orders_ru ADD COLUMN discount_rub       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_orders_ru ADD COLUMN loyalty_rub        INTEGER NOT NULL DEFAULT 0;  -- списано баллами
ALTER TABLE crm_orders_ru ADD COLUMN delivery_rub       INTEGER NOT NULL DEFAULT 0;  -- доставка в итоге заказа

ALTER TABLE crm_orders_ru ADD COLUMN delivery_provider  TEXT;    -- ozon | pickup | post
ALTER TABLE crm_orders_ru ADD COLUMN delivery_method    TEXT;    -- pickup_point | …
ALTER TABLE crm_orders_ru ADD COLUMN delivery_status    TEXT;    -- статус отправления у провайдера (сырой)
ALTER TABLE crm_orders_ru ADD COLUMN delivery_order_id  TEXT;    -- номер отправления у Ozon
ALTER TABLE crm_orders_ru ADD COLUMN tracking_number    TEXT;
ALTER TABLE crm_orders_ru ADD COLUMN delivery_cost_rub  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_orders_ru ADD COLUMN delivery_updated_at TEXT;   -- ISO8601, последнее изменение отправления

CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_sf_status  ON crm_orders_ru(storefront_status);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_paid_at    ON crm_orders_ru(paid_at);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_dlv_status ON crm_orders_ru(delivery_status);
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_tracking   ON crm_orders_ru(tracking_number);
