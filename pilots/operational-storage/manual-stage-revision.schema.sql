-- Detached LOCAL-ONLY candidate; never apply remotely without migration review.
-- Enrollment is deliberate and durable. No creator FK: deletion must not reset history.
CREATE TABLE pilot_manual_stage_enrollment (
 namespace TEXT NOT NULL, agent TEXT NOT NULL CHECK(agent IN ('angela','diana-helios')),
 creator_id TEXT PRIMARY KEY NOT NULL CHECK(length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0)
);
CREATE TABLE pilot_manual_stage_observation (
 creator_id TEXT PRIMARY KEY NOT NULL REFERENCES pilot_manual_stage_enrollment(creator_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
 present INTEGER NOT NULL CHECK(present IN (0,1)), raw_value TEXT, raw_updated_at,
 CHECK((present=0 AND raw_value IS NULL AND raw_updated_at IS NULL) OR (present=1 AND raw_value IS NOT NULL AND raw_updated_at IS NOT NULL))
);
CREATE TRIGGER pilot_manual_enrollment_no_replace BEFORE INSERT ON pilot_manual_stage_enrollment
 WHEN EXISTS(SELECT 1 FROM pilot_manual_stage_enrollment WHERE creator_id=NEW.creator_id)
 BEGIN SELECT RAISE(ABORT,'manual_enrollment_already_exists'); END;
CREATE TRIGGER pilot_manual_enrollment_no_update BEFORE UPDATE ON pilot_manual_stage_enrollment
 BEGIN SELECT RAISE(ABORT,'manual_enrollment_immutable'); END;
CREATE TRIGGER pilot_manual_enrollment_no_delete BEFORE DELETE ON pilot_manual_stage_enrollment
 BEGIN SELECT RAISE(ABORT,'manual_enrollment_immutable'); END;
CREATE TRIGGER pilot_manual_observation_no_replace BEFORE INSERT ON pilot_manual_stage_observation
 WHEN NEW.revision!=0 OR EXISTS(SELECT 1 FROM pilot_manual_stage_observation WHERE creator_id=NEW.creator_id)
 BEGIN SELECT RAISE(ABORT,'manual_observation_reset_forbidden'); END;
CREATE TRIGGER pilot_manual_observation_no_delete BEFORE DELETE ON pilot_manual_stage_observation
 BEGIN SELECT RAISE(ABORT,'manual_observation_reset_forbidden'); END;
-- RAISE rather than only CHECK: outer INSERT/UPDATE OR IGNORE must not skip a
-- failed observer increment while allowing the original manual mutation.
CREATE TRIGGER pilot_manual_observation_monotonic BEFORE UPDATE ON pilot_manual_stage_observation
 WHEN NEW.creator_id IS NOT OLD.creator_id OR typeof(NEW.revision)!='integer'
 OR OLD.revision>=9007199254740991 OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'manual_revision_exhausted_or_invalid'); END;
CREATE TRIGGER pilot_manual_enroll AFTER INSERT ON pilot_manual_stage_enrollment BEGIN
 INSERT INTO pilot_manual_stage_observation(creator_id,revision,present,raw_value,raw_updated_at)
 SELECT NEW.creator_id,0,m.key IS NOT NULL,m.value,m.updated_at
 FROM (SELECT 1) LEFT JOIN crm_sync_state m ON m.key='manual_stage:'||NEW.creator_id;
END;
CREATE TRIGGER pilot_manual_observe_insert AFTER INSERT ON crm_sync_state BEGIN
 UPDATE pilot_manual_stage_observation SET
 revision=revision+1,
 present=EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_value=(SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_updated_at=(SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 WHERE pilot_manual_stage_observation.creator_id=substr(NEW.key,length('manual_stage:')+1) AND NEW.key='manual_stage:'||pilot_manual_stage_observation.creator_id OR present IS NOT EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_value IS NOT (SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_updated_at IS NOT (SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id);
END;
CREATE TRIGGER pilot_manual_observe_update AFTER UPDATE ON crm_sync_state BEGIN
 UPDATE pilot_manual_stage_observation SET
 revision=revision+1,
 present=EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_value=(SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_updated_at=(SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 WHERE ((NEW.key IS NOT OLD.key OR NEW.rowid IS NOT OLD.rowid) AND NEW.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR present IS NOT EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_value IS NOT (SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_updated_at IS NOT (SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id);
END;
CREATE TRIGGER pilot_manual_observe_delete AFTER DELETE ON crm_sync_state BEGIN
 UPDATE pilot_manual_stage_observation SET
 revision=revision+1,
 present=EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_value=(SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id),
 raw_updated_at=(SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 WHERE present IS NOT EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_value IS NOT (SELECT value FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id)
 OR raw_updated_at IS NOT (SELECT updated_at FROM crm_sync_state m WHERE m.key='manual_stage:'||pilot_manual_stage_observation.creator_id);
END;
