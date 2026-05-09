-- =============================================================================
-- 0013_rename_gzh_bw_to_dgn.sql
-- Renames warehouse: wh_gzh_bw / GZH-BW (Guangzhou Bonded Warehouse) →
--                    wh_dgn / DGN (Dongguan Bonded Warehouse)
-- Reason: original record incorrectly placed the bonded warehouse in
-- Guangzhou. It is actually in Dongguan.
-- Safe at apply time: 0 rows in stocks / stock_movements / inventory_sessions
-- referenced wh_gzh_bw when this migration was authored.
-- =============================================================================

UPDATE warehouses
SET id = 'wh_dgn',
    code = 'DGN',
    name = 'Dongguan Bonded Warehouse',
    city = 'Dongguan',
    updated_at = strftime('%s','now')
WHERE id = 'wh_gzh_bw';
