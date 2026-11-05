-- 0153 — Owner 2026-11-05: a blogger is in the ERP only after she agreed to work with us.
-- Same cleanup as 0152 for every platform except Instagram (Instagram cards come from the direct
-- dialogue itself): cards with status empty or silent, no payout, no payment record, no working
-- collaboration and no Instagram message from her. A copy of each removed card is kept for rollback.
CREATE TABLE IF NOT EXISTS ugc_removed_creators_261105b AS
SELECT c.* FROM ugc_creators c
 WHERE COALESCE(c.lifecycle_stage,'') IN ('', 'silent')
   AND NOT EXISTS (SELECT 1 FROM ugc_creator_platforms p WHERE p.creator_id=c.id AND p.platform='instagram')
   AND EXISTS (SELECT 1 FROM ugc_creator_platforms p WHERE p.creator_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM ugc_payouts y WHERE y.creator_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM ugc_source_records r WHERE r.creator_id=c.id)
   AND NOT EXISTS (SELECT 1 FROM ugc_collaborations k WHERE k.creator_id=c.id AND COALESCE(k.status,'') NOT IN ('', 'found', 'silent'))
   AND NOT EXISTS (SELECT 1 FROM ugc_ig_messages m WHERE LOWER(COALESCE(m.from_username,'')) = LOWER(c.normalized_handle));

CREATE TABLE IF NOT EXISTS ugc_removed_platforms_261105b AS
SELECT p.* FROM ugc_creator_platforms p WHERE p.creator_id IN (SELECT id FROM ugc_removed_creators_261105b);

DELETE FROM ugc_handle_history WHERE creator_platform_id IN (SELECT id FROM ugc_removed_platforms_261105b);
DELETE FROM ugc_content WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105b);
DELETE FROM ugc_collaborations WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105b);
DELETE FROM ugc_creator_platforms WHERE creator_id IN (SELECT id FROM ugc_removed_creators_261105b);
DELETE FROM ugc_creators WHERE id IN (SELECT id FROM ugc_removed_creators_261105b);
-- Rollback: INSERT INTO ugc_creators SELECT * FROM ugc_removed_creators_261105b;
--           INSERT INTO ugc_creator_platforms SELECT * FROM ugc_removed_platforms_261105b;
