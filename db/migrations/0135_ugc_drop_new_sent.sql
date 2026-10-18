-- 0135 — Owner 2026-10-18: new and sent removed; no status is an empty word.
-- Rollback: UPDATE ugc_creators SET lifecycle_stage='new' WHERE lifecycle_stage='';
UPDATE ugc_creators SET lifecycle_stage='' WHERE lifecycle_stage IN ('new','sent','found','qualified','invited');
