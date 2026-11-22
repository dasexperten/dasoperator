-- LOCAL-ONLY synthetic source projection + handoff fence. Never a deployed migration.
CREATE TABLE pilot_erp_source (
 source_key TEXT PRIMARY KEY, request_json TEXT NOT NULL, creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0),
 profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND length(profile_id) BETWEEN 1 AND 256 AND profile_id NOT GLOB '*[^!-~]*' AND instr(profile_id,char(0))=0), collaboration_id TEXT NOT NULL CHECK(typeof(collaboration_id)='text' AND length(collaboration_id) BETWEEN 1 AND 256 AND collaboration_id NOT GLOB '*[^!-~]*' AND instr(collaboration_id,char(0))=0), mode TEXT NOT NULL CHECK(mode IN ('new','existing')),
 current_handle TEXT NOT NULL CHECK(typeof(current_handle)='text' AND length(current_handle) BETWEEN 1 AND 30 AND current_handle NOT GLOB '*[^a-z0-9._]*' AND instr(current_handle,char(0))=0 AND substr(current_handle,1,1)!='.' AND substr(current_handle,-1)!='.' AND instr(current_handle,'..')=0), lifecycle_stage TEXT NOT NULL, manual_value TEXT, manual_updated_at INTEGER, source_handle TEXT NOT NULL CHECK(typeof(source_handle)='text' AND length(source_handle) BETWEEN 1 AND 30 AND source_handle NOT GLOB '*[^a-z0-9._]*' AND instr(source_handle,char(0))=0 AND substr(source_handle,1,1)!='.' AND substr(source_handle,-1)!='.' AND instr(source_handle,'..')=0), history_json TEXT NOT NULL CHECK(length(CAST(history_json AS BLOB))<=1048576), observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at BETWEEN 0 AND 9007199254740991),
 platform TEXT NOT NULL, coverage TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT NOT NULL,
 response_ref TEXT NOT NULL, discussion_ref TEXT NOT NULL, qualification TEXT NOT NULL
);
CREATE TABLE pilot_erp_handoffs (
 source_key TEXT PRIMARY KEY, request_json TEXT NOT NULL,
 creator_id TEXT NOT NULL CHECK(typeof(creator_id)='text' AND length(creator_id) BETWEEN 1 AND 256 AND creator_id NOT GLOB '*[^!-~]*' AND instr(creator_id,char(0))=0), profile_id TEXT NOT NULL CHECK(typeof(profile_id)='text' AND length(profile_id) BETWEEN 1 AND 256 AND profile_id NOT GLOB '*[^!-~]*' AND instr(profile_id,char(0))=0), collaboration_id TEXT NOT NULL CHECK(typeof(collaboration_id)='text' AND length(collaboration_id) BETWEEN 1 AND 256 AND collaboration_id NOT GLOB '*[^!-~]*' AND instr(collaboration_id,char(0))=0) UNIQUE,
 FOREIGN KEY(creator_id) REFERENCES ugc_creators(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(profile_id) REFERENCES ugc_creator_platforms(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER pilot_erp_handoff_guard BEFORE INSERT ON pilot_erp_handoffs BEGIN
 -- Bound history BEFORE building JSON snapshots or recursive graph queries.
 SELECT CASE WHEN (SELECT count(*) FROM (SELECT 1 FROM ugc_handle_history LIMIT 2001))>2000
 OR (SELECT count(*) FROM (SELECT 1 FROM ugc_handle_history WHERE creator_platform_id=NEW.profile_id LIMIT 65))>64
 THEN RAISE(ABORT,'history_row_budget_exceeded') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ugc_handle_history WHERE
 length(CAST(id AS BLOB))>4096 OR length(CAST(creator_platform_id AS BLOB))>4096 OR length(CAST(platform AS BLOB))>4096
 OR length(CAST(old_handle AS BLOB))>4096 OR length(CAST(new_handle AS BLOB))>4096 OR length(CAST(evidence AS BLOB))>4096 OR length(CAST(changed_at AS BLOB))>4096)
 OR COALESCE((SELECT sum(length(CAST(id AS BLOB))+length(CAST(creator_platform_id AS BLOB))+length(CAST(platform AS BLOB))+length(CAST(old_handle AS BLOB))+length(CAST(new_handle AS BLOB))+length(CAST(evidence AS BLOB))+length(CAST(changed_at AS BLOB))) FROM ugc_handle_history),0)>1048576
 THEN RAISE(ABORT,'history_text_budget_exceeded') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ugc_creator_platforms WHERE platform='instagram' AND NOT (typeof(normalized_handle)='text' AND length(normalized_handle) BETWEEN 1 AND 30 AND normalized_handle NOT GLOB '*[^a-z0-9._]*' AND instr(normalized_handle,char(0))=0 AND substr(normalized_handle,1,1)!='.' AND substr(normalized_handle,-1)!='.' AND instr(normalized_handle,'..')=0))
 OR EXISTS(SELECT 1 FROM ugc_handle_history WHERE platform='instagram' AND (NOT (typeof(old_handle)='text' AND length(old_handle) BETWEEN 1 AND 30 AND old_handle NOT GLOB '*[^a-z0-9._]*' AND instr(old_handle,char(0))=0 AND substr(old_handle,1,1)!='.' AND substr(old_handle,-1)!='.' AND instr(old_handle,'..')=0) OR NOT (typeof(new_handle)='text' AND length(new_handle) BETWEEN 1 AND 30 AND new_handle NOT GLOB '*[^a-z0-9._]*' AND instr(new_handle,char(0))=0 AND substr(new_handle,1,1)!='.' AND substr(new_handle,-1)!='.' AND instr(new_handle,'..')=0)))
 THEN RAISE(ABORT,'noncanonical_instagram_identity') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM crm_sync_state WHERE key LIKE 'ugc_purged:instagram:%' AND (key NOT GLOB 'ugc_purged:instagram:*' OR NOT (length(substr(key,length('ugc_purged:instagram:')+1)) BETWEEN 1 AND 30 AND substr(key,length('ugc_purged:instagram:')+1) NOT GLOB '*[^a-z0-9._]*' AND instr(substr(key,length('ugc_purged:instagram:')+1),char(0))=0 AND substr(substr(key,length('ugc_purged:instagram:')+1),1,1)!='.' AND substr(substr(key,length('ugc_purged:instagram:')+1),-1)!='.' AND instr(substr(key,length('ugc_purged:instagram:')+1),'..')=0)))
 THEN RAISE(ABORT,'noncanonical_purge_marker') END;

 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE collaboration_id=NEW.collaboration_id AND source_key!=NEW.source_key)
 THEN RAISE(ABORT,'cross_source_collaboration_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ugc_collaborations WHERE id=NEW.collaboration_id) AND NOT EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key AND collaboration_id=NEW.collaboration_id)
 THEN RAISE(ABORT,'preexisting_collaboration_conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND s.request_json=NEW.request_json
 AND s.creator_id=NEW.creator_id AND s.profile_id=NEW.profile_id AND s.collaboration_id=NEW.collaboration_id
 AND s.qualification='substantive' AND s.platform='instagram' AND s.coverage='complete' AND s.state='current' AND s.outcome='settled'
 AND length(s.response_ref)>0 AND length(s.discussion_ref)>0
 AND json_extract(NEW.request_json,'$.manualStage')=s.lifecycle_stage
 AND json_extract(NEW.request_json,'$.responseRef')=s.response_ref
 AND json_extract(NEW.request_json,'$.discussionRef')=s.discussion_ref)
 THEN RAISE(ABORT,'source_checkpoint_or_coverage_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs h WHERE h.source_key=NEW.source_key AND
 (h.request_json!=NEW.request_json OR h.creator_id!=NEW.creator_id OR h.profile_id!=NEW.profile_id OR h.collaboration_id!=NEW.collaboration_id))
 THEN RAISE(ABORT,'handoff_identity_conflict') END;
 -- Exact current manual-state CAS, NOT an invented monotonic revision.
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND (
 (s.manual_value IS NULL AND s.manual_updated_at IS NULL AND NOT EXISTS(SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||s.creator_id))
 OR (s.manual_value IS NOT NULL AND s.manual_updated_at IS NOT NULL AND EXISTS(SELECT 1 FROM crm_sync_state m WHERE m.key='manual_stage:'||s.creator_id AND m.value=s.manual_value AND m.updated_at=s.manual_updated_at
 AND CASE WHEN json_valid(m.value) THEN json_type(m.value,'$.to')='text' AND json_extract(m.value,'$.to')=s.lifecycle_stage AND json_type(m.value,'$.at') IN ('integer','real') ELSE 0 END))))
 THEN RAISE(ABORT,'manual_state_conflict') END;
 -- Whole history checkpoint is conservative: even unrelated changes require reread.
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND s.history_json=
 (SELECT json_group_array(json(record)) FROM (SELECT json_object('id',id,'creator_platform_id',creator_platform_id,'platform',platform,'old_handle',old_handle,'new_handle',new_handle,'evidence',evidence,'changed_at',changed_at) AS record FROM ugc_handle_history ORDER BY id)))
 THEN RAISE(ABORT,'history_checkpoint_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_source s JOIN crm_sync_state m ON m.key IN ('ugc_purged:instagram:'||s.current_handle,'ugc_purged:instagram:'||s.source_handle) WHERE s.source_key=NEW.source_key)
 OR EXISTS(SELECT 1 FROM ugc_handle_history h JOIN crm_sync_state m ON m.key IN ('ugc_purged:instagram:'||h.old_handle,'ugc_purged:instagram:'||h.new_handle) WHERE h.creator_platform_id=NEW.profile_id)
 THEN RAISE(ABORT,'purged_identity') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND
 (s.mode='existing' OR EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key)) AND NOT EXISTS(
 SELECT 1 FROM ugc_creators c JOIN ugc_creator_platforms p ON p.creator_id=c.id WHERE c.id=s.creator_id AND p.id=s.profile_id
 AND p.platform=s.platform AND p.normalized_handle=s.current_handle AND c.lifecycle_stage=s.lifecycle_stage
 AND c.archived_at IS NULL AND (p.availability_status IS NULL OR p.availability_status='available')))
 THEN RAISE(ABORT,'identity_stage_or_availability_conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key)
 AND EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND s.mode='new' AND (
 s.lifecycle_stage!='' OR s.source_handle!=s.current_handle OR s.manual_value IS NOT NULL
 OR EXISTS(SELECT 1 FROM ugc_creators WHERE id=s.creator_id OR lower(normalized_handle)=s.current_handle)
 OR EXISTS(SELECT 1 FROM ugc_creator_platforms WHERE id=s.profile_id OR normalized_handle=s.current_handle)
 OR EXISTS(SELECT 1 FROM ugc_handle_history WHERE old_handle=s.current_handle OR new_handle=s.current_handle)))
 THEN RAISE(ABORT,'new_identity_conflict') END;
 -- Resolve a historical source handle only via actual same-profile history edges.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_source s WHERE s.source_key=NEW.source_key AND s.source_handle!=s.current_handle AND NOT EXISTS(
 WITH RECURSIVE reachable(handle) AS (SELECT s.source_handle UNION SELECT h.new_handle FROM ugc_handle_history h JOIN reachable r ON h.old_handle=r.handle WHERE h.creator_platform_id=s.profile_id AND h.platform=s.platform)
 SELECT 1 FROM reachable WHERE handle=s.current_handle)) THEN RAISE(ABORT,'alias_unresolved') END;
 -- Fail closed for cycles, orphan/cross-platform edges, disconnected history,
 -- or aliases now assigned to another actual profile/history family.
 SELECT CASE WHEN EXISTS(
 WITH RECURSIVE edges(start,handle) AS (SELECT old_handle,new_handle FROM ugc_handle_history WHERE creator_platform_id=NEW.profile_id UNION SELECT e.start,h.new_handle FROM edges e JOIN ugc_handle_history h ON h.old_handle=e.handle WHERE h.creator_platform_id=NEW.profile_id)
 SELECT 1 FROM edges WHERE start=handle)
 THEN RAISE(ABORT,'alias_cycle') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ugc_handle_history h WHERE h.creator_platform_id=NEW.profile_id AND (h.platform!='instagram' OR NOT EXISTS(
 WITH RECURSIVE reachable(handle) AS (SELECT h.new_handle UNION SELECT x.new_handle FROM ugc_handle_history x JOIN reachable r ON x.old_handle=r.handle WHERE x.creator_platform_id=NEW.profile_id)
 SELECT 1 FROM reachable r JOIN pilot_erp_source s ON s.source_key=NEW.source_key AND r.handle=s.current_handle)))
 THEN RAISE(ABORT,'disconnected_history') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_source s JOIN ugc_creator_platforms p ON p.platform=s.platform WHERE s.source_key=NEW.source_key AND p.id!=s.profile_id AND
 (p.normalized_handle IN (s.current_handle,s.source_handle) OR p.normalized_handle IN (SELECT old_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id UNION SELECT new_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id)))
 OR EXISTS(SELECT 1 FROM pilot_erp_source s JOIN ugc_handle_history h ON h.platform=s.platform WHERE s.source_key=NEW.source_key AND h.creator_platform_id!=s.profile_id AND
 (h.old_handle IN (s.current_handle,s.source_handle) OR h.new_handle IN (s.current_handle,s.source_handle)
 OR h.old_handle IN (SELECT old_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id UNION SELECT new_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id)
 OR h.new_handle IN (SELECT old_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id UNION SELECT new_handle FROM ugc_handle_history WHERE creator_platform_id=s.profile_id)))
 THEN RAISE(ABORT,'alias_ownership_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key) AND NOT EXISTS(
 SELECT 1 FROM ugc_collaborations c WHERE c.id=NEW.collaboration_id AND c.creator_id=NEW.creator_id AND c.platform='instagram' AND c.status='replied' AND c.accepted_at IS NULL)
 THEN RAISE(ABORT,'collaboration_readback_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key) THEN RAISE(IGNORE) END;
END;
CREATE TRIGGER pilot_erp_handoff_create AFTER INSERT ON pilot_erp_handoffs BEGIN
 INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,created_at,updated_at)
 SELECT creator_id,current_handle,'',observed_at,observed_at FROM pilot_erp_source WHERE source_key=NEW.source_key AND mode='new';
 INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at)
 SELECT profile_id,creator_id,platform,current_handle,current_handle,observed_at,observed_at FROM pilot_erp_source WHERE source_key=NEW.source_key AND mode='new';
 INSERT INTO ugc_collaborations(id,creator_id,platform,status,created_at,updated_at)
 SELECT collaboration_id,creator_id,platform,'replied',observed_at,observed_at FROM pilot_erp_source WHERE source_key=NEW.source_key;
END;
CREATE TRIGGER pilot_erp_handoff_no_update BEFORE UPDATE ON pilot_erp_handoffs BEGIN SELECT RAISE(ABORT,'immutable_handoff'); END;
CREATE TRIGGER pilot_erp_handoff_no_delete BEFORE DELETE ON pilot_erp_handoffs BEGIN SELECT RAISE(ABORT,'immutable_handoff'); END;
