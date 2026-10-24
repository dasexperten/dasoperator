-- Owner confirmed 2026-10-24: DE201A is one DE201 tube.
-- Exact legacy listing only; no historical transactions or stock counts change.
UPDATE marketplace_ozon_sku_map
SET base_sku = 'de201', pack_factor = 1
WHERE ozon_sku = 1276899149
  AND LOWER(offer_id) = 'de201a'
  AND product_id = 712328428
  AND base_sku = 'de201a'
  AND pack_factor = 1;
