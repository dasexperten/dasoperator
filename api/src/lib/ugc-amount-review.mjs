// Save a missing amount on an EXISTING payout. Never approve, pay or send.
// A source/identity/provider review is still required: every save retains a
// server-side payout_hold, which the execution claim checks atomically.
const columns = ['id','creator_id','creator_platform_id','amount_minor','currency','status','payout_date',
  'phone_masked','bank_ref','fps_bank_member_id','product','konsol_payment_id','konsol_contractor_id','konsol_status','execute_claim','updated_at'];
const privateColumns = ['payout_id','fps_mobile_phone','first_name','last_name','patronymic','updated_at'];
const select = `SELECT ${columns.map(k=>`p.${k}`).join(',')},
  ${privateColumns.map(k=>`r.${k} AS r_${k}`).join(',')},
  (SELECT value FROM crm_sync_state WHERE key='payout_hold:' || p.id) hold_value
  FROM ugc_payouts p LEFT JOIN ugc_payout_requisites r ON r.payout_id=p.id`;
const keys = [...columns,...privateColumns.map(k=>`r_${k}`),'hold_value'];
const plain = x => x!==null && typeof x==='object' && !Array.isArray(x);
const uuid = x => typeof x==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const id = x => typeof x==='string' && x.length>0 && x.length<=120;
const editable = r => r && r.currency==='RUB' && r.amount_minor===1 && ['awaiting_approval','approved'].includes(r.status)
  && !r.execute_claim && !r.konsol_payment_id && !r.konsol_contractor_id && !r.konsol_status;
const failure=(http,code)=>({ok:false,http,code});
const receiptKey=(payoutId,requestId)=>`ugc_amount_review:${payoutId}:${requestId}`;
const statement=(db,sql,...args)=>db.prepare(sql).bind(...args);
async function fingerprint(row) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(keys.map(k=>row[k]??null))));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
function view(row,snapshot,saved=null) {
  return {id:row.id,creator_id:row.creator_id,amount_minor:row.amount_minor,status:row.status,
    updated_at:row.updated_at,payout_hold:row.hold_value!==null,review_snapshot:snapshot,
    can_edit:editable(row),saved_request:saved};
}
async function matchingReceipt(raw,row,requestId) {
  if(!raw) return null;
  let r;try{r=JSON.parse(raw);}catch{return null;}
  if(r.version!==1||r.id!==row.id||r.creator_id!==row.creator_id||r.request_id!==requestId
    ||r.amount_minor!==row.amount_minor||row.hold_value===null||row.execute_claim||row.konsol_payment_id
    ||row.konsol_contractor_id||row.konsol_status||!['awaiting_approval','approved'].includes(row.status)
    ||typeof r.expected_snapshot!=='string'||!/^[a-f0-9]{64}$/.test(r.expected_snapshot)
    ||r.saved_snapshot!==await fingerprint(row))return null;
  return {request_id:r.request_id,expected_snapshot:r.expected_snapshot,amount_minor:r.amount_minor};
}

/** The hash is a CAS snapshot, never proof of original-message identity or truth. */
export async function readAmountReview(db,payoutId,requestId=null) {
  if(!id(payoutId)||(requestId!==null&&!uuid(requestId)))return failure(422,'invalid_amount_review');
  try {
    const row=await statement(db,`${select} WHERE p.id=?1`,payoutId).first();
    if(!row)return failure(404,'not_found');
    let saved=null;
    if(requestId) {
      const receipt=await statement(db,'SELECT value FROM crm_sync_state WHERE key=?1',receiptKey(payoutId,requestId)).first();
      saved=await matchingReceipt(receipt?.value,row,requestId);
    }
    return {ok:true,payout:view(row,await fingerprint(row),saved)};
  }catch{return failure(503,'amount_review_unavailable');}
}

/** Admin access and body shape are enforced again by the mounted route. */
export async function saveAmountReview(db,input) {
  if(!plain(input)||Object.keys(input).some(k=>!['id','creator_id','expected_snapshot','amount_minor','request_id','actor_id','now'].includes(k))
    ||!id(input.id)||!id(input.creator_id)||!id(input.actor_id)||!uuid(input.request_id)
    ||typeof input.expected_snapshot!=='string'||!/^[a-f0-9]{64}$/.test(input.expected_snapshot)
    ||!Number.isSafeInteger(input.amount_minor)||input.amount_minor<5000||input.amount_minor>299900
    ||!Number.isSafeInteger(input.now)||input.now<0)return failure(422,'invalid_amount_review');
  const key=receiptKey(input.id,input.request_id),holdKey=`payout_hold:${input.id}`;
  let row,prior;
  try {
    row=await statement(db,`${select} WHERE p.id=?1`,input.id).first();
    if(!row)return failure(404,'not_found');
    prior=await statement(db,'SELECT value FROM crm_sync_state WHERE key=?1',key).first();
  }catch{return failure(503,'amount_review_unavailable');}
  if(prior) {
    const saved=await matchingReceipt(prior.value,row,input.request_id);
    if(!saved||saved.expected_snapshot!==input.expected_snapshot||saved.amount_minor!==input.amount_minor
      ||row.creator_id!==input.creator_id)return failure(409,'amount_review_conflict');
    return {ok:true,replay:true,payout:view(row,await fingerprint(row),saved)};
  }
  if(row.creator_id!==input.creator_id||!editable(row)||await fingerprint(row)!==input.expected_snapshot)
    return failure(409,'amount_review_conflict');
  const attempt=crypto.randomUUID();
  const holdJson=JSON.stringify({kind:'amount_review',version:1,id:input.id,request_id:input.request_id,
    actor_id:input.actor_id,amount_minor:input.amount_minor,at:input.now});
  const savedSnapshot=await fingerprint({...row,amount_minor:input.amount_minor,updated_at:input.now,hold_value:row.hold_value??holdJson});
  const receipt={version:1,id:input.id,creator_id:input.creator_id,request_id:input.request_id,
    expected_snapshot:input.expected_snapshot,amount_minor:input.amount_minor,actor_id:input.actor_id,
    at:input.now,attempt,saved_snapshot:savedSnapshot};
  const receiptJson=JSON.stringify(receipt);
  // Snapshot predicates compare actual nullable values, not updated_at alone.
  const expressions=[...columns.map(k=>`p.${k}`),...privateColumns.map(k=>`r.${k}`),
    `(SELECT value FROM crm_sync_state WHERE key='payout_hold:' || p.id)`];
  const cas=expressions.map((expr,i)=>`${expr} IS ?${i+4}`).join(' AND ');
  const afterCas=expressions.map((expr,i)=>`${expr} IS ?${i+3}`).join(' AND ');
  const expectedAfter={...row,amount_minor:input.amount_minor,updated_at:input.now,hold_value:row.hold_value??holdJson};
  const owner=`EXISTS(SELECT 1 FROM crm_sync_state WHERE key=?1 AND value=?2)`;
  let result;
  try {
    result=await db.batch([
      statement(db,`INSERT INTO crm_sync_state(key,value,updated_at)
        SELECT ?1,?2,?3 FROM ugc_payouts p LEFT JOIN ugc_payout_requisites r ON r.payout_id=p.id
        WHERE ${cas} ON CONFLICT(key) DO NOTHING`,key,receiptJson,input.now,...keys.map(k=>row[k]??null)),
      statement(db,`INSERT INTO crm_sync_state(key,value,updated_at)
        SELECT ?3,?4,?5 WHERE ${owner} ON CONFLICT(key) DO NOTHING`,key,receiptJson,holdKey,holdJson,input.now),
      statement(db,`UPDATE ugc_payouts SET amount_minor=?4,updated_at=?5 WHERE id=?3 AND ${owner}`,
        key,receiptJson,input.id,input.amount_minor,input.now),
      // Fail the ENTIRE batch if an owned write cannot be verified. json() is
      // available in D1 SQLite; an invalid document deliberately aborts/rolls back.
      statement(db,`SELECT json(CASE WHEN NOT (${owner}) OR EXISTS(
        SELECT 1 FROM ugc_payouts p LEFT JOIN ugc_payout_requisites r ON r.payout_id=p.id
        WHERE ${afterCas}) THEN 'null' ELSE 'amount_review_atomicity_failure' END) AS verified`,
        key,receiptJson,...keys.map(k=>expectedAfter[k]??null)),
      statement(db,`${select} WHERE p.id=?1`,input.id),
      statement(db,'SELECT value FROM crm_sync_state WHERE key=?1',key),
    ]);
  }catch{return failure(503,'amount_review_unavailable');}
  if(!Array.isArray(result)||result.length!==6||result.some(r=>r?.success!==true)
    ||![0,1].includes(result[0]?.meta?.changes)||![0,1].includes(result[1]?.meta?.changes)
    ||result[2]?.meta?.changes!==result[0]?.meta?.changes
    ||!Array.isArray(result[3]?.results)||result[3].results.length!==1||result[3].results[0]?.verified!=='null'
    ||!Array.isArray(result[4]?.results)||result[4].results.length!==1
    ||!Array.isArray(result[5]?.results)||result[5].results.length>1)
    return failure(503,'amount_review_not_verified');
  const final=result[4].results[0],saved=await matchingReceipt(result[5].results[0]?.value,final,input.request_id);
  if(!saved||final.id!==input.id||final.creator_id!==input.creator_id
    ||saved.expected_snapshot!==input.expected_snapshot||saved.amount_minor!==input.amount_minor)
    return failure(result[0].meta.changes===1?503:409,result[0].meta.changes===1?'amount_review_not_verified':'amount_review_conflict');
  return {ok:true,replay:result[0].meta.changes===0,payout:view(final,await fingerprint(final),saved)};
}
