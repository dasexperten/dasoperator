-- SYNTHETIC LOCAL FIXTURE ONLY. Not a production migration.
-- These projected tables deliberately omit unrelated production columns.
CREATE TABLE atomic_creators (id TEXT NOT NULL CHECK(typeof(id)='text' AND length(id) BETWEEN 1 AND 256 AND id NOT GLOB '*[^!-~]*' AND instr(id,char(0))=0) PRIMARY KEY, lifecycle_stage TEXT NOT NULL, manual_revision TEXT NOT NULL);
CREATE TABLE atomic_profiles (id TEXT NOT NULL CHECK(typeof(id)='text' AND length(id) BETWEEN 1 AND 256 AND id NOT GLOB '*[^!-~]*' AND instr(id,char(0))=0) PRIMARY KEY, creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0) REFERENCES atomic_creators(id), platform TEXT NOT NULL, normalized_handle TEXT NOT NULL, UNIQUE(platform,normalized_handle));
CREATE TABLE atomic_aliases (handle TEXT PRIMARY KEY, profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND length(profile_id) BETWEEN 1 AND 256 AND profile_id NOT GLOB '*[^!-~]*' AND instr(profile_id,char(0))=0));
CREATE TABLE atomic_exclusions (handle TEXT PRIMARY KEY);
-- This projection MUST be maintained by a trusted, coherent source integration.
-- No endpoint can insert/update it. Fixture coverage is NOT production evidence.
CREATE TABLE atomic_source (
 source_key TEXT PRIMARY KEY, request_json TEXT NOT NULL, creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0),
 profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND length(profile_id) BETWEEN 1 AND 256 AND profile_id NOT GLOB '*[^!-~]*' AND instr(profile_id,char(0))=0), collaboration_id TEXT NOT NULL CHECK(typeof(collaboration_id)='text' AND length(collaboration_id) BETWEEN 1 AND 256 AND collaboration_id NOT GLOB '*[^!-~]*' AND instr(collaboration_id,char(0))=0), mode TEXT NOT NULL CHECK(mode IN ('new','existing')),
 current_handle TEXT NOT NULL, lifecycle_stage TEXT NOT NULL, manual_revision TEXT NOT NULL,
 platform TEXT NOT NULL, coverage TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT NOT NULL,
 response_ref TEXT NOT NULL, discussion_ref TEXT NOT NULL, qualification TEXT NOT NULL
);
CREATE TABLE atomic_collaborations (id TEXT NOT NULL CHECK(typeof(id)='text' AND length(id) BETWEEN 1 AND 256 AND id NOT GLOB '*[^!-~]*' AND instr(id,char(0))=0) PRIMARY KEY, creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0) REFERENCES atomic_creators(id), status TEXT NOT NULL CHECK(status='replied'), response_ref TEXT NOT NULL, discussion_ref TEXT NOT NULL);
CREATE TABLE atomic_handoffs (
 source_key TEXT PRIMARY KEY, request_json TEXT NOT NULL,
 creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0), profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND length(profile_id) BETWEEN 1 AND 256 AND profile_id NOT GLOB '*[^!-~]*' AND instr(profile_id,char(0))=0), collaboration_id TEXT NOT NULL CHECK(typeof(collaboration_id)='text' AND length(collaboration_id) BETWEEN 1 AND 256 AND collaboration_id NOT GLOB '*[^!-~]*' AND instr(collaboration_id,char(0))=0) UNIQUE,
 FOREIGN KEY(creator_id) REFERENCES atomic_creators(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(profile_id) REFERENCES atomic_profiles(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER atomic_handoff_guard BEFORE INSERT ON atomic_handoffs BEGIN
 -- Explicitly reject UNIQUE conflicts before REPLACE can remove another fence.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_handoffs WHERE collaboration_id=NEW.collaboration_id AND source_key!=NEW.source_key)
 THEN RAISE(ABORT,'cross_source_collaboration_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_collaborations WHERE id=NEW.collaboration_id) AND NOT EXISTS(SELECT 1 FROM atomic_handoffs WHERE source_key=NEW.source_key AND collaboration_id=NEW.collaboration_id)
 THEN RAISE(ABORT,'preexisting_collaboration_conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM atomic_source s WHERE s.source_key=NEW.source_key AND s.request_json=NEW.request_json
 AND s.creator_id=NEW.creator_id AND s.profile_id=NEW.profile_id AND s.collaboration_id=NEW.collaboration_id
 AND s.qualification='substantive' AND s.platform='instagram' AND s.coverage='complete' AND s.state='current' AND s.outcome='settled'
 AND length(s.response_ref)>0 AND length(s.discussion_ref)>0
 AND json_extract(NEW.request_json,'$.manualStage')=s.lifecycle_stage
 AND json_extract(NEW.request_json,'$.responseRef')=s.response_ref
 AND json_extract(NEW.request_json,'$.discussionRef')=s.discussion_ref)
 THEN RAISE(ABORT,'source_checkpoint_or_coverage_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_handoffs h WHERE h.source_key=NEW.source_key AND
 (h.request_json!=NEW.request_json OR h.creator_id!=NEW.creator_id OR h.profile_id!=NEW.profile_id OR h.collaboration_id!=NEW.collaboration_id))
 THEN RAISE(ABORT,'handoff_identity_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_source s JOIN atomic_exclusions e ON e.handle=s.current_handle WHERE s.source_key=NEW.source_key)
 OR EXISTS(SELECT 1 FROM atomic_aliases a JOIN atomic_exclusions e ON e.handle=a.handle WHERE a.profile_id=NEW.profile_id)
 THEN RAISE(ABORT,'purge_or_dnc_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_source s WHERE s.source_key=NEW.source_key AND
 (s.mode='existing' OR EXISTS(SELECT 1 FROM atomic_handoffs WHERE source_key=NEW.source_key)) AND NOT EXISTS(
 SELECT 1 FROM atomic_creators c JOIN atomic_profiles p ON p.creator_id=c.id WHERE c.id=s.creator_id AND p.id=s.profile_id
 AND p.platform=s.platform AND p.normalized_handle=s.current_handle AND c.lifecycle_stage=s.lifecycle_stage AND c.manual_revision=s.manual_revision))
 THEN RAISE(ABORT,'identity_or_manual_stage_conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM atomic_handoffs WHERE source_key=NEW.source_key)
 AND EXISTS(SELECT 1 FROM atomic_source s WHERE s.source_key=NEW.source_key AND s.mode='new' AND (
 s.lifecycle_stage!='' OR EXISTS(SELECT 1 FROM atomic_creators WHERE id=s.creator_id)
 OR EXISTS(SELECT 1 FROM atomic_profiles WHERE id=s.profile_id OR normalized_handle=s.current_handle)
 OR EXISTS(SELECT 1 FROM atomic_aliases WHERE handle=s.current_handle)))
 THEN RAISE(ABORT,'new_identity_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_handoffs h WHERE h.source_key=NEW.source_key)
 AND NOT EXISTS(SELECT 1 FROM atomic_collaborations c JOIN atomic_source s ON s.source_key=NEW.source_key WHERE c.id=NEW.collaboration_id AND c.creator_id=NEW.creator_id AND c.response_ref=s.response_ref AND c.discussion_ref=s.discussion_ref)
 THEN RAISE(ABORT,'collaboration_readback_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_source s JOIN atomic_aliases a ON a.handle=s.current_handle WHERE s.source_key=NEW.source_key AND a.profile_id!=NEW.profile_id)
 THEN RAISE(ABORT,'alias_identity_conflict') END;
 -- Prevent INSERT OR REPLACE from removing the durable fence, even with recursive triggers off.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM atomic_handoffs WHERE source_key=NEW.source_key) THEN RAISE(IGNORE) END;
END;
CREATE TRIGGER atomic_handoff_create AFTER INSERT ON atomic_handoffs BEGIN
 INSERT INTO atomic_creators SELECT creator_id,lifecycle_stage,manual_revision FROM atomic_source WHERE source_key=NEW.source_key AND mode='new';
 INSERT INTO atomic_profiles SELECT profile_id,creator_id,platform,current_handle FROM atomic_source WHERE source_key=NEW.source_key AND mode='new';
 INSERT INTO atomic_collaborations SELECT collaboration_id,creator_id,'replied',response_ref,discussion_ref FROM atomic_source WHERE source_key=NEW.source_key;
END;
CREATE TRIGGER atomic_handoff_no_update BEFORE UPDATE ON atomic_handoffs BEGIN SELECT RAISE(ABORT,'immutable_handoff'); END;
CREATE TRIGGER atomic_handoff_no_delete BEFORE DELETE ON atomic_handoffs BEGIN SELECT RAISE(ABORT,'immutable_handoff'); END;
