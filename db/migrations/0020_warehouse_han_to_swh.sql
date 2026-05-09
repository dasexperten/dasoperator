-- Phase 8.x — rename warehouse han → swh for ID/code consistency
-- Old state: id='han' code='SWH' (mismatch)
-- New state: id='swh' code='SWH' (lowercase ID = lowercase(code))
-- All other warehouses (dgn, flp, gzh, jeb, lbr, srn, yer, yzh) already follow this rule.
--
-- This migration is documentation-only — the change was applied directly to D1 prod
-- via REST API on 2026-05-09 (insert clone with new id, repoint warehouse_companies,
-- delete old id, restore swh ↔ dasean primary link).
--
-- Note: warehouse 'han' name was 'Swift Hub' (not 'Hanoi Bonded' as in 0002 seed).
-- The seed file is historical reference only; live DB has been amended.

INSERT INTO warehouses (id, code, name, country, city, warehouse_type, notes, created_at, updated_at, owner_company_id)
SELECT 'swh', code, name, country, city, warehouse_type, notes, created_at, updated_at, owner_company_id
FROM warehouses WHERE id='han'
ON CONFLICT(id) DO NOTHING;

UPDATE warehouse_companies SET warehouse_id='swh' WHERE warehouse_id='han';

DELETE FROM warehouses WHERE id='han';
