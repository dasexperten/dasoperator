-- Owner 2026-11-04: a creator who accepted and has no reel for more than 10 days shows on a light brown row.
-- The clock is the payment date; without a payment, the moment the creator entered an accepted stage.
-- Accepted stages: agreed, cart, paid, ordered, creation. The stamp is set by the database itself,
-- so every writer (the page, Diana's Instagram replies, imports) is covered without code changes.
ALTER TABLE ugc_creators ADD COLUMN accepted_at INTEGER;

-- Creators already accepted get today as their start: no earlier date exists for them.
UPDATE ugc_creators SET accepted_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE accepted_at IS NULL AND lifecycle_stage IN ('agreed','cart','paid','ordered','creation');

CREATE TRIGGER IF NOT EXISTS ugc_creators_accepted_at_upd
AFTER UPDATE OF lifecycle_stage ON ugc_creators
WHEN NEW.lifecycle_stage IN ('agreed','cart','paid','ordered','creation')
 AND (OLD.lifecycle_stage IS NULL OR OLD.lifecycle_stage NOT IN ('agreed','cart','paid','ordered','creation'))
BEGIN
  UPDATE ugc_creators SET accepted_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS ugc_creators_accepted_at_ins
AFTER INSERT ON ugc_creators
WHEN NEW.lifecycle_stage IN ('agreed','cart','paid','ordered','creation') AND NEW.accepted_at IS NULL
BEGIN
  UPDATE ugc_creators SET accepted_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = NEW.id;
END;
