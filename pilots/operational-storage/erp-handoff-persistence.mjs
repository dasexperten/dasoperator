/** Local-only persistence bridge for the accepted detached atomic handoff service.
 * No production resource configuration, source/auth verifier or route is supplied.
 * The two fixed statements are translated to local pilot mapping/projection tables;
 * their triggers use actual pinned ugc_* / crm_sync_state fields, never copy tables.
 */
const normalize=sql=>typeof sql==='string'?sql.replace(/\s+/g,' ').trim():'';
const insert=`INSERT INTO atomic_handoffs(source_key,request_json,creator_id,profile_id,collaboration_id)
 SELECT ?,?,creator_id,profile_id,collaboration_id FROM atomic_source WHERE source_key=?
 ON CONFLICT(source_key) DO NOTHING`;
const read='SELECT h.source_key,h.request_json,h.creator_id,h.profile_id,h.collaboration_id FROM atomic_handoffs h JOIN atomic_source s ON s.source_key=h.source_key WHERE h.source_key=?';
const statements=new Map([[normalize(insert),'insert'],[normalize(read),'read']]);
export function createErpHandoffPersistence(db) {
 const issued=new WeakMap();
 return Object.freeze({
  prepare(sql) {
   const kind=statements.get(normalize(sql));if(!kind)throw new Error('unsupported_handoff_statement');
   const translated=sql.replaceAll('atomic_handoffs','pilot_erp_handoffs').replaceAll('atomic_source','pilot_erp_source');
   return Object.freeze({bind(...args){
    if((kind==='insert'&&(args.length!==3||args[0]!==args[2]))||(kind==='read'&&args.length!==1)||args.some(v=>typeof v!=='string'))throw new Error('invalid_handoff_bindings');
    const token=Object.freeze({});issued.set(token,{kind,sourceKey:args[0],statement:db.prepare(translated).bind(...args)});return token;
   }});
  },
  async batch(tokens) {
   if(!Array.isArray(tokens)||tokens.length!==2)throw new Error('invalid_handoff_batch');
   const [write,read]=tokens.map(t=>issued.get(t));
   if(write?.kind!=='insert'||read?.kind!=='read'||write.sourceKey!==read.sourceKey)throw new Error('invalid_handoff_batch');
   return db.batch([write.statement,read.statement]);
  },
 });
}
