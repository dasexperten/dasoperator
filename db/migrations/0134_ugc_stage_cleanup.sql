-- 0134 — Owner 2026-10-18: payout and review removed; cart = basket + requisites (yellow);
-- statuses follow the facts. Forward-only backfill from payouts.
-- Rollback: statuses are plain text; the removed words can be written back by hand.
UPDATE ugc_creators SET lifecycle_stage='cart' WHERE lifecycle_stage='payout';
UPDATE ugc_creators SET lifecycle_stage='posted' WHERE lifecycle_stage='review';
UPDATE ugc_collaborations SET status='cart' WHERE status='payout';
UPDATE ugc_collaborations SET status='posted' WHERE status='review';
UPDATE ugc_creators SET lifecycle_stage='paid'
 WHERE archived_at IS NULL AND COALESCE(lifecycle_stage,'new') IN ('new','sent','replied','agreed','cart')
   AND EXISTS (SELECT 1 FROM ugc_payouts p WHERE p.creator_id=ugc_creators.id AND p.status IN ('paid','sent'));
UPDATE ugc_creators SET lifecycle_stage='cart'
 WHERE archived_at IS NULL AND COALESCE(lifecycle_stage,'new') IN ('new','sent','replied','agreed')
   AND EXISTS (SELECT 1 FROM ugc_payouts p WHERE p.creator_id=ugc_creators.id AND p.status IN ('awaiting_approval','approved'));
