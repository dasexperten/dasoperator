-- LOCAL ONLY alternative mapping model. Intent is a route-internal transaction
-- coordination device, NEVER an authorization grant. Existing route auth stays.
CREATE TABLE pilot_erp_intent_commit_guard (id TEXT PRIMARY KEY);
CREATE TRIGGER pilot_erp_intent_guard_no_rows BEFORE INSERT ON pilot_erp_intent_commit_guard BEGIN SELECT CASE WHEN NEW.id='current_purge_eligibility_missing' THEN RAISE(ABORT,'current_purge_eligibility_missing') ELSE RAISE(ABORT,'intent_must_be_consumed') END; END;
CREATE TABLE pilot_erp_mutation_intent (
 from_creator_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('merge','delete')),
 into_creator_id TEXT, into_profile_id TEXT,
 pending TEXT NOT NULL DEFAULT 'pending' REFERENCES pilot_erp_intent_commit_guard(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='merge' AND into_creator_id IS NOT NULL AND into_profile_id IS NOT NULL AND from_creator_id!=into_creator_id) OR (kind='delete' AND into_creator_id IS NULL AND into_profile_id IS NULL))
);
CREATE TRIGGER pilot_erp_intent_validate BEFORE INSERT ON pilot_erp_mutation_intent BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_mutation_intent WHERE from_creator_id=NEW.from_creator_id) THEN RAISE(ABORT,'duplicate_intent') END;
 SELECT CASE WHEN NEW.kind='merge' AND NOT EXISTS(SELECT 1 FROM ugc_creator_platforms p JOIN ugc_creators c ON c.id=p.creator_id WHERE p.id=NEW.into_profile_id AND c.id=NEW.into_creator_id AND p.platform='instagram') THEN RAISE(ABORT,'merge_target_missing') END;
END;
CREATE TRIGGER pilot_erp_intent_no_update BEFORE UPDATE ON pilot_erp_mutation_intent BEGIN SELECT RAISE(ABORT,'immutable_mutation_intent'); END;
CREATE TRIGGER pilot_erp_intent_complete BEFORE DELETE ON pilot_erp_mutation_intent BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ugc_creators WHERE id=OLD.from_creator_id) THEN RAISE(ABORT,'mutation_not_complete') END;
END;
CREATE TABLE pilot_erp_case_mapping (
 source_key TEXT PRIMARY KEY REFERENCES pilot_erp_handoffs(source_key), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('active','deleted')),
 creator_id TEXT REFERENCES ugc_creators(id) DEFERRABLE INITIALLY DEFERRED,
 profile_id TEXT REFERENCES ugc_creator_platforms(id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((state='active' AND creator_id IS NOT NULL AND profile_id IS NOT NULL) OR (state='deleted' AND creator_id IS NULL AND profile_id IS NULL))
);
CREATE TABLE pilot_erp_case_events (
 source_key TEXT NOT NULL REFERENCES pilot_erp_handoffs(source_key), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
 kind TEXT NOT NULL CHECK(kind IN ('enroll','merge','delete')), from_creator_id TEXT, from_profile_id TEXT,
 creator_id TEXT, profile_id TEXT, human_snapshot TEXT NOT NULL,
 PRIMARY KEY(source_key,revision)
);
CREATE TRIGGER pilot_erp_events_no_replace BEFORE INSERT ON pilot_erp_case_events WHEN EXISTS(SELECT 1 FROM pilot_erp_case_events WHERE source_key=NEW.source_key AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT,'immutable_case_event'); END;
CREATE TRIGGER pilot_erp_events_no_update BEFORE UPDATE ON pilot_erp_case_events BEGIN SELECT RAISE(ABORT,'immutable_case_event'); END;
CREATE TRIGGER pilot_erp_events_no_delete BEFORE DELETE ON pilot_erp_case_events BEGIN SELECT RAISE(ABORT,'immutable_case_event'); END;
CREATE TRIGGER pilot_erp_mapping_no_replace BEFORE INSERT ON pilot_erp_case_mapping WHEN EXISTS(SELECT 1 FROM pilot_erp_case_mapping WHERE source_key=NEW.source_key) BEGIN SELECT RAISE(ABORT,'permanent_case_mapping'); END;
CREATE TRIGGER pilot_erp_mapping_no_delete BEFORE DELETE ON pilot_erp_case_mapping BEGIN SELECT RAISE(ABORT,'permanent_case_mapping'); END;
CREATE TRIGGER pilot_erp_mapping_transition BEFORE UPDATE ON pilot_erp_case_mapping BEGIN
 SELECT CASE WHEN OLD.state!='active' OR NEW.source_key!=OLD.source_key OR NEW.revision!=OLD.revision+1 OR NOT EXISTS(
 SELECT 1 FROM pilot_erp_case_events e WHERE e.source_key=NEW.source_key AND e.revision=NEW.revision AND e.from_creator_id=OLD.creator_id AND e.from_profile_id=OLD.profile_id AND e.creator_id IS NEW.creator_id AND e.profile_id IS NEW.profile_id AND e.kind=CASE NEW.state WHEN 'active' THEN 'merge' ELSE 'delete' END)
 THEN RAISE(ABORT,'invalid_mapping_transition') END;
END;
CREATE TRIGGER pilot_erp_mapped_collaboration_delete BEFORE DELETE ON ugc_collaborations WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs h JOIN pilot_erp_case_mapping m USING(source_key) WHERE h.collaboration_id=OLD.id AND m.state='active') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_mutation_intent i WHERE i.from_creator_id=OLD.creator_id AND i.kind='delete') THEN RAISE(ABORT,'mapped_delete_requires_intent') END;
END;
-- Preserve known alias evidence before exact legacy purge deletes history first.
CREATE TABLE pilot_erp_retired_aliases (
 source_key TEXT NOT NULL REFERENCES pilot_erp_handoffs(source_key), revision INTEGER NOT NULL,
 history_id TEXT NOT NULL, old_handle TEXT NOT NULL, new_handle TEXT NOT NULL,
 history_json TEXT NOT NULL, PRIMARY KEY(source_key,revision,history_id),
 FOREIGN KEY(source_key,revision) REFERENCES pilot_erp_case_events(source_key,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER pilot_erp_alias_no_replace BEFORE INSERT ON pilot_erp_retired_aliases WHEN EXISTS(SELECT 1 FROM pilot_erp_retired_aliases WHERE source_key=NEW.source_key AND revision=NEW.revision AND history_id=NEW.history_id) BEGIN SELECT RAISE(ABORT,'immutable_retired_alias'); END;
CREATE TRIGGER pilot_erp_alias_no_update BEFORE UPDATE ON pilot_erp_retired_aliases BEGIN SELECT RAISE(ABORT,'immutable_retired_alias'); END;
CREATE TRIGGER pilot_erp_alias_no_delete BEFORE DELETE ON pilot_erp_retired_aliases BEGIN SELECT RAISE(ABORT,'immutable_retired_alias'); END;
CREATE TRIGGER pilot_erp_mapped_history_delete BEFORE DELETE ON ugc_handle_history WHEN EXISTS(SELECT 1 FROM pilot_erp_case_mapping WHERE profile_id=OLD.creator_platform_id AND state='active') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_mutation_intent i JOIN ugc_creator_platforms p ON p.creator_id=i.from_creator_id WHERE p.id=OLD.creator_platform_id AND i.kind='delete') THEN RAISE(ABORT,'mapped_delete_requires_intent') END;
 INSERT INTO pilot_erp_retired_aliases SELECT m.source_key,m.revision+1,OLD.id,OLD.old_handle,OLD.new_handle,
 json_object('id',OLD.id,'creator_platform_id',OLD.creator_platform_id,'platform',OLD.platform,'old_handle',OLD.old_handle,'new_handle',OLD.new_handle,'evidence',OLD.evidence,'changed_at',OLD.changed_at)
 FROM pilot_erp_case_mapping m WHERE m.profile_id=OLD.creator_platform_id AND m.state='active';
END;
CREATE TRIGGER pilot_erp_mapped_profile_delete BEFORE DELETE ON ugc_creator_platforms WHEN EXISTS(SELECT 1 FROM pilot_erp_case_mapping WHERE profile_id=OLD.id AND state='active') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pilot_erp_mutation_intent WHERE from_creator_id=OLD.creator_id) THEN RAISE(ABORT,'mapped_delete_requires_intent') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_mutation_intent i WHERE i.from_creator_id=OLD.creator_id AND i.kind='merge' AND NOT EXISTS(SELECT 1 FROM ugc_creator_platforms p WHERE p.id=i.into_profile_id AND p.creator_id=i.into_creator_id AND p.platform='instagram')) THEN RAISE(ABORT,'merge_target_missing') END;
 INSERT INTO pilot_erp_case_events SELECT m.source_key,m.revision+1,i.kind,m.creator_id,m.profile_id,i.into_creator_id,i.into_profile_id,
 json_object('lifecycle_stage',c.lifecycle_stage,'notes',c.notes,'origin',c.origin,'accepted_at',c.accepted_at,'manual_value',(SELECT value FROM crm_sync_state WHERE key='manual_stage:'||c.id),'manual_updated_at',(SELECT updated_at FROM crm_sync_state WHERE key='manual_stage:'||c.id),'handle',OLD.normalized_handle)
 FROM pilot_erp_case_mapping m JOIN pilot_erp_mutation_intent i ON i.from_creator_id=OLD.creator_id JOIN ugc_creators c ON c.id=OLD.creator_id WHERE m.profile_id=OLD.id AND m.state='active';
 UPDATE pilot_erp_case_mapping SET revision=revision+1,state=CASE (SELECT kind FROM pilot_erp_mutation_intent WHERE from_creator_id=OLD.creator_id) WHEN 'merge' THEN 'active' ELSE 'deleted' END,
 creator_id=(SELECT into_creator_id FROM pilot_erp_mutation_intent WHERE from_creator_id=OLD.creator_id),profile_id=(SELECT into_profile_id FROM pilot_erp_mutation_intent WHERE from_creator_id=OLD.creator_id) WHERE profile_id=OLD.id AND state='active';
END;

