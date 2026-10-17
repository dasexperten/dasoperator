ALTER TABLE ugc_creator_platforms ADD COLUMN avatar_key TEXT;
ALTER TABLE ugc_creator_platforms ADD COLUMN posts_count INTEGER;
ALTER TABLE ugc_creator_platforms ADD COLUMN er_sample_posts INTEGER;
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_checked_at TEXT;
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_attempted_at TEXT;
ALTER TABLE ugc_creator_platforms ADD COLUMN profile_error TEXT;
ALTER TABLE ugc_creator_platforms ADD COLUMN er_checked_at TEXT;
UPDATE ugc_creator_platforms SET er_checked_at=metrics_as_of WHERE engagement_rate IS NOT NULL;
