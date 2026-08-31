-- Migration 0080: у склада появляется его идентификатор на Ozon.
--
-- 31.08.2026 все пять названных Владельцем складов заведены на Ozon по схеме FBS и
-- активны. Без этого столбца связь «наш склад ↔ склад Ozon» существовала только в
-- тексте примечания, а заливка остатков `v2/products/stocks` требует именно числа:
-- у метода обязательный параметр `warehouse_id`.
--
-- Идемпотентна по данным (UPDATE по id). Столбец добавляется один раз — повторный
-- прогон упрётся в «duplicate column name», это ожидаемо и безопасно.
--
-- Числа сняты живым `POST /v2/warehouse/list` 31.08.2026, все пять в статусе `created`.

ALTER TABLE warehouses ADD COLUMN ozon_warehouse_id INTEGER;

UPDATE warehouses SET ozon_warehouse_id = 1020002326126000 WHERE id = 'furor';
UPDATE warehouses SET ozon_warehouse_id = 1020005028923280 WHERE id = 'spb';
UPDATE warehouses SET ozon_warehouse_id = 1020005028923870 WHERE id = 'lbr';
UPDATE warehouses SET ozon_warehouse_id = 1020005028928730 WHERE id = 'kaz';
UPDATE warehouses SET ozon_warehouse_id = 1020005028929200 WHERE id = 'ffbase';
