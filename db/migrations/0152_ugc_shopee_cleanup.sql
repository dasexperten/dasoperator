-- 0152 — Owner 2026-11-05: a blogger is in the ERP only when a dialogue with her has started
-- (she agreed and the specifics are being discussed). Shopee scouting cards with no dialogue
-- (status empty or silent, no payout, no payment record, no working collaboration) are removed.
-- A copy of every removed card and profile is kept in the two tables below for rollback.
CREATE TABLE IF NOT EXISTS ugc_removed_creators_261105 AS
SELECT c.* FROM ugc_creators c
 WHERE COALESCE(c.lifecycle_stage,'') IN ('', 'silent')
   AND EXISTS (SELECT 1 FROM ugc_creator_platforms p WHERE p.creator_id=c.id AND p.platform='shopee')
   AND NOT EXISTS (SELECT 1 FROM ugc_creator_platforms p WHERE p.creator_id=c.id AND p.platform<>'shopee')
   AND NOT EXISTS (SELECT 1 FROM ugc_payouts y WHERE y.creator_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM ugc_source_records r WHERE r.creator_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM ugc_collaborations k WHERE k.creator_id=c.id AND COALESCE(k.status,'') NOT IN ('', 'found', 'silent'));

CREATE TABLE IF NOT EXISTS ugc_removed_platforms_261105 AS
SELECT p.* FROM ugc_creator_platforms p WHERE p.creator_id IN (SELECT id FROM ugc_removed_creators_261105);

DELETE FROM ugc_handle_history WHERE creator_platform_id IN (SELECT id FROM ugc_removed_platforms_261105);
DELETE FROM ugc_content WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105);
DELETE FROM ugc_collaborations WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105);
DELETE FROM ugc_creator_platforms WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105);
DELETE FROM ugc_creators WHERE id IN (SELECT id FROM ugc_removed_creators_261105);
-- Rollback: INSERT INTO ugc_creators SELECT * FROM ugc_removed_creators_261105;
--           INSERT INTO ugc_creator_platforms SELECT * FROM ugc_removed_platforms_261105;
