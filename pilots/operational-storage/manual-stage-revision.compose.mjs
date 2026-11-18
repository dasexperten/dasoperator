/** Node-only local schema composition. Never runtime authorization or remote DDL. */
import {createHash} from 'node:crypto';
const pinnedGuardSha256='8425bf5f391f3e3ef60fe1f09cced63b9df38ec1c4bfe9d905ae843b15881392';
const revisionPredicate=` SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM pilot_manual_handoff_checkpoint p JOIN pilot_manual_stage_observation o ON o.creator_id=p.creator_id
 JOIN pilot_manual_stage_enrollment e ON e.creator_id=o.creator_id
 WHERE e.namespace=json_extract(NEW.request_json,'$.namespace') AND e.agent=json_extract(NEW.request_json,'$.agent') AND p.source_key=NEW.source_key AND p.creator_id=NEW.creator_id AND p.revision=o.revision
 AND o.present IS EXISTS(SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)
 AND o.raw_value IS (SELECT value FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)
 AND o.raw_updated_at IS (SELECT updated_at FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)
 ) THEN RAISE(ABORT,'manual_revision_conflict') END;
`;
export function composeManualRevisionHandoffSchema(schema){
 if(typeof schema!=='string')throw Error('unexpected_manual_handoff_schema');
 const start='CREATE TRIGGER pilot_erp_handoff_guard BEFORE INSERT ON pilot_erp_handoffs BEGIN';
 const next='CREATE TRIGGER pilot_erp_handoff_create';
 if(schema.split(start).length!==2||schema.split(next).length!==2)throw Error('unexpected_manual_handoff_guard');
 const from=schema.indexOf(start),to=schema.indexOf(next);
 if(to<=from)throw Error('unexpected_manual_handoff_guard');
 const guard=schema.slice(from,to).trimEnd();
 if(createHash('sha256').update(guard).digest('hex')!==pinnedGuardSha256)throw Error('unverified_manual_handoff_guard');
 const replay=" SELECT CASE WHEN EXISTS(SELECT 1 FROM pilot_erp_handoffs WHERE source_key=NEW.source_key) THEN RAISE(IGNORE) END;";
 if(guard.split(replay).length!==2)throw Error('unexpected_manual_handoff_replay');
 // In the SAME verified trigger, before replay IGNORE. Separate BEFORE triggers
 // cannot enforce this: IGNORE skips subsequent triggers in unspecified order.
 return schema.slice(0,from)+guard.replace(replay,revisionPredicate+replay)+schema.slice(from+guard.length);
}
