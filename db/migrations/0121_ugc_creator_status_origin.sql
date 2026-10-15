-- 0121 — Diana's creator statuses and origin mark (Owner 2026-10-15,
-- DH-LAW-261015-02): every status is one English word of at most 7 letters.
--
-- Main path: new · sent · replied · agreed · cart · payout · paid · ordered ·
--            review · posted · gold
-- Side:      silent · failed · fee · refused · unfit · rival · claim · owner
--
-- origin — who started, set once: 'invited' (we found and wrote first, brown
-- magnifier) or 'self' (the creator came to us, green raised hand). NULL until
-- Diana has established it; the old import does not tell.
--
-- Old stages map: found/qualified → new, invited → sent, accepted → agreed,
-- sample_delivered → ordered, published/orders_mature → posted, renew → gold,
-- stop → refused. Rollback: reverse the UPDATEs; origin is nullable and unused by older code.

ALTER TABLE ugc_creators ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('invited', 'self'));

UPDATE ugc_creators SET lifecycle_stage = CASE lifecycle_stage
  WHEN 'found' THEN 'new'
  WHEN 'qualified' THEN 'new'
  WHEN 'invited' THEN 'sent'
  WHEN 'accepted' THEN 'agreed'
  WHEN 'sample_delivered' THEN 'ordered'
  WHEN 'published' THEN 'posted'
  WHEN 'orders_mature' THEN 'posted'
  WHEN 'renew' THEN 'gold'
  WHEN 'stop' THEN 'refused'
  ELSE lifecycle_stage END;

UPDATE ugc_collaborations SET status = CASE status
  WHEN 'found' THEN 'new'
  WHEN 'qualified' THEN 'new'
  WHEN 'invited' THEN 'sent'
  WHEN 'accepted' THEN 'agreed'
  WHEN 'sample_delivered' THEN 'ordered'
  WHEN 'published' THEN 'posted'
  WHEN 'orders_mature' THEN 'posted'
  WHEN 'renew' THEN 'gold'
  WHEN 'stop' THEN 'refused'
  ELSE status END;
