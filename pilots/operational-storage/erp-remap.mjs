/** Detached integration helpers. Not mounted; no authorization implementation.
 * Called ONLY inside the existing authorized route after its original validation.
 * SQL intent is not authority. No metadata-only merge inference exists.
 */
export function mergeIntentStatements(db,{from,into,targetProfile},originalStatements){
 if(!from||!into||!targetProfile||from===into||!Array.isArray(originalStatements)||!originalStatements.length)throw Error('invalid_merge_integration');
 return [db.prepare("INSERT INTO pilot_erp_mutation_intent(from_creator_id,kind,into_creator_id,into_profile_id) VALUES (?,'merge',?,?)").bind(from,into,targetProfile),...originalStatements,db.prepare('DELETE FROM pilot_erp_mutation_intent WHERE from_creator_id=?').bind(from)];
}
// Read-only identity resolution, NOT a fresh transfer receipt/qualification proof.
// Caller must authenticate and verify trusted source before invoking; current
// manual decision/revision must be re-observed before any subsequent ERP write.
export async function resolveStoredHandoff(db,sourceKey,requestJson){
 if(typeof sourceKey!=='string'||!sourceKey||typeof requestJson!=='string'||!requestJson)throw Error('invalid_handoff_resolution');
 const r=await db.prepare(`SELECT h.source_key,h.request_json,h.collaboration_id,m.state,m.revision,m.creator_id,m.profile_id,
 c.id actual_creator,p.creator_id actual_profile_creator,k.creator_id actual_collaboration_creator,
 s.state source_state,s.outcome,s.coverage,s.qualification
 FROM pilot_erp_handoffs h JOIN pilot_erp_case_mapping m USING(source_key)
 LEFT JOIN ugc_creators c ON c.id=m.creator_id LEFT JOIN ugc_creator_platforms p ON p.id=m.profile_id
 LEFT JOIN ugc_collaborations k ON k.id=h.collaboration_id LEFT JOIN pilot_erp_source s USING(source_key)
 WHERE h.source_key=?`).bind(sourceKey).first();
 if(!r)throw Error('handoff_unknown');
 const fields=['source_key','request_json','collaboration_id','state','revision','creator_id','profile_id','actual_creator','actual_profile_creator','actual_collaboration_creator','source_state','outcome','coverage','qualification'];
 if(typeof r!=='object'||fields.some(k=>!Object.getOwnPropertyDescriptor(r,k)||!('value' in Object.getOwnPropertyDescriptor(r,k)))||r.source_key!==sourceKey||!Number.isSafeInteger(r.revision)||r.revision<0||!['active','deleted'].includes(r.state))throw Error('handoff_readback_invalid');
 if(r.request_json!==requestJson)throw Error('handoff_request_conflict');
 if(r.state==='deleted')throw Error('handoff_deleted_permanently');
 if(['creator_id','profile_id','collaboration_id'].some(k=>typeof r[k]!=='string'||! /^[\x21-\x7e]{1,256}$/.test(r[k])))throw Error('handoff_readback_invalid');
 if(r.source_state!=='current'||r.outcome!=='settled'||r.coverage!=='complete'||r.qualification!=='substantive')throw Error('handoff_source_unresolved');
 if(r.actual_creator!==r.creator_id||r.actual_profile_creator!==r.creator_id||r.actual_collaboration_creator!==r.creator_id)throw Error('handoff_identity_unresolved');
 return Object.freeze({sourceKey,creatorId:r.creator_id,profileId:r.profile_id,collaborationId:r.collaboration_id,mappingRevision:r.revision,resolutionOnly:true});
}

// Exact pinned recurring-purge eligibility, evaluated in the destructive batch.
export const currentPurgeEligibilitySql=`
    SELECT c.id, p.normalized_handle handle
      FROM ugc_creators c
      JOIN ugc_creator_platforms p ON p.creator_id = c.id AND p.platform = 'instagram'
     WHERE COALESCE(c.lifecycle_stage, '') IN ('', 'silent')
       AND c.created_at <= ?1
       AND NOT EXISTS (SELECT 1 FROM ugc_ig_messages m WHERE m.direction = 'in' AND LOWER(COALESCE(m.from_username, '')) = LOWER(p.normalized_handle))
       AND NOT EXISTS (SELECT 1 FROM ugc_payouts y WHERE y.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_source_records r WHERE r.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_content k WHERE k.creator_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ugc_collaborations k WHERE k.creator_id = c.id AND COALESCE(k.status, '') NOT IN ('', 'found', 'silent'))
     LIMIT ?2`;
export function currentEligiblePurgeStatements(db,{creatorId,now},originalStatements){
 if(typeof creatorId!=='string'||!creatorId||!Number.isSafeInteger(now)||now<0||!Array.isArray(originalStatements)||!originalStatements.length)throw Error('invalid_purge_integration');
 return [db.prepare(`INSERT INTO pilot_erp_mutation_intent(from_creator_id,kind) SELECT id,'delete' FROM (${currentPurgeEligibilitySql}) WHERE id=?3`).bind(now-7*24*3600*1000,200,creatorId),db.prepare("INSERT INTO pilot_erp_intent_commit_guard(id) SELECT 'current_purge_eligibility_missing' WHERE NOT EXISTS(SELECT 1 FROM pilot_erp_mutation_intent WHERE from_creator_id=? AND kind='delete')").bind(creatorId),...originalStatements,db.prepare('DELETE FROM pilot_erp_mutation_intent WHERE from_creator_id=?').bind(creatorId)];
}
