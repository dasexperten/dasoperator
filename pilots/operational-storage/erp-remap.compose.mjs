/** Node-only LOCAL schema composition. Supported order: manual composer first,
 * then this remap composer. Both hash-check their exact input guard. */
import {createHash} from 'node:crypto';
const manualGuardSha256='0a69b33520215f0be4fb5058779dbecd74bf02b775e32a084b68c97cef2a30d4';
const retiredPredicate=` SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_retired_aliases WHERE NOT (typeof(old_handle)='text' AND length(old_handle) BETWEEN 1 AND 30 AND old_handle NOT GLOB '*[^a-z0-9._]*' AND instr(old_handle,char(0))=0 AND substr(old_handle,1,1)!='.' AND substr(old_handle,-1)!='.' AND instr(old_handle,'..')=0) OR NOT (typeof(new_handle)='text' AND length(new_handle) BETWEEN 1 AND 30 AND new_handle NOT GLOB '*[^a-z0-9._]*' AND instr(new_handle,char(0))=0 AND substr(new_handle,1,1)!='.' AND substr(new_handle,-1)!='.' AND instr(new_handle,'..')=0) OR json_extract(history_json,'$.platform')!='instagram') THEN RAISE(ABORT,'retained_alias_unresolved') END;
 SELECT CASE WHEN (NOT EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key) AND EXISTS(SELECT 1 FROM pilot_erp_case_events e WHERE e.kind IN ('merge','delete') AND (e.from_creator_id=NEW.creator_id OR e.from_profile_id=NEW.profile_id)))
 OR EXISTS(SELECT 1 FROM pilot_erp_case_events e JOIN pilot_erp_source s ON s.source_key=NEW.source_key WHERE e.kind='delete' AND json_extract(e.human_snapshot,'$.handle') IN (s.current_handle,s.source_handle))
 OR EXISTS(SELECT 1 FROM pilot_erp_retired_aliases a JOIN pilot_erp_source s ON s.source_key=NEW.source_key WHERE a.old_handle IN (s.current_handle,s.source_handle) OR a.new_handle IN (s.current_handle,s.source_handle))
 OR EXISTS(SELECT 1 FROM pilot_erp_retired_aliases a JOIN ugc_handle_history h ON h.creator_platform_id=NEW.profile_id WHERE a.old_handle IN (h.old_handle,h.new_handle) OR a.new_handle IN (h.old_handle,h.new_handle))
 THEN RAISE(ABORT,'retired_handoff_identity') END;
`;
function insertRetiredGuard(schema){
 const start='CREATE TRIGGER pilot_erp_handoff_guard BEFORE INSERT ON pilot_erp_handoffs BEGIN';
 const next='CREATE TRIGGER pilot_erp_handoff_create';
 if(schema.split(start).length!==2||schema.split(next).length!==2)throw Error('unexpected_remap_handoff_guard');
 const from=schema.indexOf(start),to=schema.indexOf(next),guard=schema.slice(from,to).trimEnd();
 if(to<=from||createHash('sha256').update(guard).digest('hex')!==manualGuardSha256)throw Error('unverified_manual_composed_guard');
 const replay=" SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key) THEN RAISE(IGNORE) END;";
 if(guard.split(replay).length!==2)throw Error('unexpected_remap_handoff_replay');
 return schema.slice(0,from)+guard.replace(replay,retiredPredicate+replay)+schema.slice(from+guard.length);
}
export function composeRemappingHandoffSchema(acceptedSchema) {
 const fks=`,\n FOREIGN KEY(creator_id) REFERENCES ugc_creators(id) DEFERRABLE INITIALLY DEFERRED,\n FOREIGN KEY(profile_id) REFERENCES ugc_creator_platforms(id) DEFERRABLE INITIALLY DEFERRED`;
 if(acceptedSchema.split(fks).length!==2)throw Error('unexpected_accepted_schema');
 const anchor=` SELECT collaboration_id,creator_id,platform,'replied',observed_at,observed_at FROM pilot_erp_source WHERE source_key=NEW.source_key;\nEND;`;
 if(acceptedSchema.split(anchor).length!==2)throw Error('unexpected_create_trigger');
 // Explicit alternative: immutable original IDs become historical references.
 // Live deferred FKs move to the versioned current mapping; not silently disabled.
 const guarded=insertRetiredGuard(acceptedSchema);
 return guarded.replace(fks,'').replace(anchor,anchor.slice(0,-4)+`
 INSERT INTO pilot_erp_case_mapping VALUES(NEW.source_key,0,'active',NEW.creator_id,NEW.profile_id);
 INSERT INTO pilot_erp_case_events SELECT NEW.source_key,0,'enroll',NULL,NULL,NEW.creator_id,NEW.profile_id,
 json_object('lifecycle_stage',c.lifecycle_stage,'notes',c.notes,'origin',c.origin,'accepted_at',c.accepted_at,'manual_value',s.manual_value,'manual_updated_at',s.manual_updated_at)
 FROM ugc_creators c JOIN pilot_erp_source s ON s.source_key=NEW.source_key WHERE c.id=NEW.creator_id;
END;`);
}
