-- Migration 0017: clean break — unified partners + prefix removal
-- Applied to prod 2026-05-08
--
-- THIS MIGRATION RECORDS WHAT WAS APPLIED LIVE TO D1 das_erp_dev.
-- It is reproducible from a fresh-state DB but the prod DB already has
-- these changes — DO NOT re-run blindly.
--
-- Changes:
--   1. Deleted 5 fake/synthetic contracts (DEE-AP-2024-04, DEE-TM-2024-02,
--      DEE-TW-2024-01, DEE-NT-2024-05, DEI-VS-2024-03) along with their
--      11 operations, 36 line_items, 14 documents, 2 payments,
--      1 stock_movement.
--      Decision rule: contracts must reference a real signed paper
--      document. Synthetic placeholder contract numbers are forbidden.
--
--   2. partners table absorbs manufacturers (4 rows) and shippers (6 rows).
--      New canonical column `kind` introduced with CHECK constraint:
--      ('buyer','manufacturer','service_provider','shipper','3pl','other').
--      partner_type kept for backward compatibility with parallel chat
--      until invoicer fully migrates.
--      Added columns to partners to absorb manufacturer fields:
--        legal_name_en, legal_name_cn, registered_address_en, slug,
--        city, address, role, bank_notes, has_dual_route_banking,
--        is_packaging_manufacturer, is_legal_seller, modes.
--
--   3. shippers table dropped (orphan — no FK references).
--      manufacturers table KEPT for parallel chat compatibility but its
--      data is mirrored in partners. Once parallel chat migrates, drop.
--
--   4. All ID prefixes stripped:
--      - mfr_*  →  *  (in manufacturers + all FK references)
--      - shp_*  →  *  (in partners only; old table dropped)
--      - wh_*   →  *  (in warehouses + all FK references)
--      - cmp_*  →  *  (in companies + all FK references)
--      - pt_*   →  *  (in price_types + all FK references)
--      - ctr_*  →  *  (in contracts + all FK references)
--      - seq_*  →  *  (in sequences; no FK)
--
--   5. operations table: cleared shipper_id values that pointed to
--      orphan shp_* entries (none in practice).

-- ===================================================================
-- Schema additions to partners
-- ===================================================================

ALTER TABLE partners ADD COLUMN legal_name_en TEXT;
ALTER TABLE partners ADD COLUMN legal_name_cn TEXT;
ALTER TABLE partners ADD COLUMN registered_address_en TEXT;
ALTER TABLE partners ADD COLUMN slug TEXT;
ALTER TABLE partners ADD COLUMN city TEXT;
ALTER TABLE partners ADD COLUMN address TEXT;
ALTER TABLE partners ADD COLUMN role TEXT;
ALTER TABLE partners ADD COLUMN bank_notes TEXT;
ALTER TABLE partners ADD COLUMN has_dual_route_banking INTEGER NOT NULL DEFAULT 0
  CHECK (has_dual_route_banking IN (0,1));
ALTER TABLE partners ADD COLUMN is_packaging_manufacturer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partners ADD COLUMN is_legal_seller INTEGER NOT NULL DEFAULT 0;
ALTER TABLE partners ADD COLUMN modes TEXT;

ALTER TABLE partners ADD COLUMN kind TEXT
  CHECK (kind IN ('buyer','manufacturer','service_provider','shipper','3pl','other')
         OR kind IS NULL);

-- ===================================================================
-- Drop orphan shippers table
-- ===================================================================
DROP TABLE IF EXISTS shippers;

-- ===================================================================
-- NOTES FOR PARALLEL CHAT
-- ===================================================================
-- Tables touched by this migration:
--   partners (schema + data: 4 manuf rows + 6 shipper rows added)
--   manufacturers (id values stripped, table kept for compat)
--   warehouses, companies, price_types, contracts, sequences (id values stripped)
--   operations (FK columns updated)
--   products (manufacturer_id, packaging_manufacturer_id stripped)
--   documents (issuer_id stripped)
--   payments, stocks, stock_movements, inventory_sessions (FK columns stripped)
--   warehouse_companies, warehouse_manufacturers (FK columns stripped)
--   product_manufacturers, manufacturer_bank_routes (FK columns stripped)
--   company_bank_accounts, company_bank_accounts_old (company_id stripped)
--   bundling_items (warehouse_id stripped)
--
-- API/Frontend code that references prefixed IDs MUST be updated.
-- Parallel chat: invoicer skill still reads from `manufacturers` table.
-- Both `manufacturers` (4 rows) and `partners` where kind='manufacturer'
-- (4 rows) hold the same data, same IDs (honghui, jinxia, meizhiyuan, wdaa).
-- Switch reads to partners at your convenience, then drop manufacturers.
