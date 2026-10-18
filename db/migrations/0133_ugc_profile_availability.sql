-- Owner 2026-10-18: unavailable Instagram accounts stay visible with a faded row.
-- Availability is observed separately from collaboration, payments and archive.
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_status TEXT CHECK (availability_status IN ('available', 'unavailable'));
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_checked_at TEXT;
ALTER TABLE ugc_creator_platforms ADD COLUMN availability_note TEXT;
