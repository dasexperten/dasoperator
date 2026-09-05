-- Подстатус Ozon и разбивка заказа на части в зеркале .ru (Владелец 05.09.2026:
-- «многие отправления не получили»).
--
-- Зачем. Статус отправления остаётся `delivering` и когда посылка едет, и когда
-- она уже доехала и лежит в пункте выдачи. Отличает эти два состояния только
-- подстатус `posting_in_pickup_point`, а его в ленте не было — поэтому
-- невыкупленная посылка не видна ни на одном экране ERP. 05.09.2026 таких
-- стояло пять, самая старая — пятые сутки, и нашлись они только поштучным
-- опросом Ozon руками.
--
-- Второе. Ozon режет заказ на части по своим складам, и части приезжают в
-- разные дни: заказ 0155836752-0026 покупатель забрал на две трети 31.08, а
-- третья часть из ОМСК_РФЦ простояла в том же пункте с 03.09. На экране заказ
-- при этом одной строкой и одним словом `delivering`.
--
-- Считает разбивку витрина при опросе Ozon (site/ru/server/api/order/track.php)
-- и отдаёт готовыми полями: разбирать сырой JSON отправлений при каждом чтении
-- ленты нельзя — её читают целиком, 1800+ заказов, и она уже рвалась на
-- передаче (инцидент 29.08.2026).
--
-- Персональных данных здесь по-прежнему нет: это счётчики и служебный код
-- состояния, адрес ПВЗ и получатель в ленту не входят.

ALTER TABLE crm_orders_ru ADD COLUMN delivery_substatus       TEXT;    -- posting_in_pickup_point | posting_on_way_to_city | posting_transferring_to_delivery | posting_received | …
ALTER TABLE crm_orders_ru ADD COLUMN delivery_parts_total     INTEGER NOT NULL DEFAULT 0;  -- на сколько посылок Ozon разрезал заказ
ALTER TABLE crm_orders_ru ADD COLUMN delivery_parts_at_point  INTEGER NOT NULL DEFAULT 0;  -- сколько уже лежит в пункте выдачи и ждёт покупателя
ALTER TABLE crm_orders_ru ADD COLUMN delivery_parts_received  INTEGER NOT NULL DEFAULT 0;  -- сколько покупатель забрал

-- Главный запрос экрана: показать невыкупленное. Частичный индекс — строк с
-- ненулевым счётчиком единицы, полный индекс по колонке был бы дороже пользы.
CREATE INDEX IF NOT EXISTS idx_crm_orders_ru_at_point
  ON crm_orders_ru(delivery_parts_at_point) WHERE delivery_parts_at_point > 0;
