-- Detached checkpoint table. Compose the revision gate into the verified
-- accepted guard using composeManualRevisionHandoffSchema before installing it.
-- A trusted coherent source observation must pin this revision, not fetch a new
-- revision immediately before handoff to bless stale qualification evidence.
CREATE TABLE pilot_manual_handoff_checkpoint (
 source_key TEXT PRIMARY KEY NOT NULL,
 creator_id TEXT NOT NULL REFERENCES pilot_manual_stage_enrollment(creator_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991)
);
