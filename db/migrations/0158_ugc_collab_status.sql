-- Owner 2026-11-07 (Marika): an Instagram post can carry our account as a collaborator (Collab).
-- confirmed = @dasexperten is an accepted co-author (Graph collaborative_media);
-- requested = the creator invited us and the invite is still open (Graph collaboration_invites).
ALTER TABLE ugc_content ADD COLUMN collab_status TEXT CHECK (collab_status IS NULL OR collab_status IN ('requested','confirmed'));
ALTER TABLE ugc_content ADD COLUMN collab_checked_at TEXT;
