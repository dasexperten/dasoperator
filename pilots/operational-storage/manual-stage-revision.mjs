/** Local-only persistence primitive. No writer, source verifier, route or authority grant. */
const validId=id=>{if(typeof id!=='string'||! /^[\x21-\x7e]{1,256}$/.test(id))throw Error('invalid_manual_creator_id');return id;};
const readSql=`SELECT o.creator_id,o.revision,o.present,o.raw_value,o.raw_updated_at,
 (o.present IS EXISTS(SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)
 AND o.raw_value IS (SELECT value FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)
 AND o.raw_updated_at IS (SELECT updated_at FROM crm_sync_state WHERE key='manual_stage:'||o.creator_id)) AS consistent
 FROM pilot_manual_stage_observation o JOIN pilot_manual_stage_enrollment e USING(creator_id) WHERE o.creator_id=? AND e.namespace=? AND e.agent=?`;
function checkpoint(row,id){
 if(!row||row.creator_id!==id||!Number.isSafeInteger(row.revision)||row.revision<0||![0,1].includes(row.present)||row.consistent!==1
 ||(row.present===0&&(row.raw_value!==null||row.raw_updated_at!==null)))throw Error('manual_observation_missing_or_uncertain');
 return Object.freeze({creatorId:id,revision:row.revision,present:row.present===1,rawValue:row.raw_value,rawUpdatedAt:row.raw_updated_at});
}
export function createManualStageRevision(db,options={}){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype||Reflect.ownKeys(options).some(k=>!['namespace','agent','enabled'].includes(k))
 ||Object.values(Object.getOwnPropertyDescriptors(options)).some(d=>!d.enumerable||!Object.hasOwn(d,'value')))throw Error('invalid_manual_options');
 const namespace=Object.hasOwn(options,'namespace')?options.namespace:undefined;
 const agent=Object.hasOwn(options,'agent')?options.agent:undefined;
 const enabled=Object.hasOwn(options,'enabled')?options.enabled:false;
 const ready=()=>{if(enabled!==true)throw Error('manual_revision_disabled');
  if(typeof namespace!=='string'||!/^pilot-[a-z0-9][a-z0-9-]{0,47}$/.test(namespace)||!['angela','diana-helios'].includes(agent))throw Error('invalid_manual_scope');};
 return Object.freeze({
  async enroll(creatorId){
   ready();const id=validId(creatorId);
   const result=await db.batch([
    db.prepare('INSERT INTO pilot_manual_stage_enrollment(namespace,agent,creator_id) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM pilot_manual_stage_enrollment WHERE creator_id=?)').bind(namespace,agent,id,id),
    db.prepare(readSql).bind(id,namespace,agent),
   ]);
   if(!Array.isArray(result)||result.length!==2||result.some(r=>r?.success!==true)||result[1].results?.length!==1)throw Error('manual_enrollment_uncertain_reconcile_same_creator');
   return checkpoint(result[1].results[0],id);
  },
  async observe(creatorId){ready();const id=validId(creatorId);return checkpoint(await db.prepare(readSql).bind(id,namespace,agent).first(),id);},
 });
}
