/** Detached candidate bridge, never a live exporter or source mutator. */
import {pilotMode,sha256} from './store.mjs';
const enc=new TextEncoder();
const SELECTION=Object.freeze({org_task_runs:'pending_runs_join_task_title',agent_chat_messages:'oldest_500_undistilled_chat_projection'});
const fail=code=>{throw Error(code);};
function exact(value,keys) {
 if(!value || Object.getPrototypeOf(value)!==Object.prototype || Reflect.ownKeys(value).length!==keys.length
   || keys.some(k=>!Object.hasOwn(value,k)) || Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value')||!d.enumerable)) fail('invalid_snapshot_shape');
}
// Matches the real exporter's canonical rowsJson for JSON-safe selected values.
// Reject non-JSON/accessor/unsafe-integer input instead of silently dropping it.
function canonical(value,depth=0,budget={units:0}) {
 budget.units+=typeof value==='string'?value.length:1;
 if(budget.units>1048576) fail('snapshot_structure_limit');
 if(depth>100) fail('snapshot_depth_limit');
 if(value===null || typeof value==='string' || typeof value==='boolean') return value;
 if(typeof value==='number') {if(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))) fail('unsafe_snapshot_number');return value;}
 if(!value || typeof value!=='object') fail('non_json_snapshot_value');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Array.isArray(value)) {
  if(Reflect.ownKeys(value).length!==value.length+1 || Object.entries(descriptors).some(([k,d])=>k!=='length'&&(!Object.hasOwn(d,'value')||!d.enumerable))) fail('invalid_snapshot_array');
  return Array.from({length:value.length},(_,i)=>{if(!Object.hasOwn(value,i)) fail('invalid_snapshot_array');return canonical(descriptors[i].value,depth+1,budget);});
 }
 if(Object.getPrototypeOf(value)!==Object.prototype || Reflect.ownKeys(value).some(k=>typeof k!=='string')
   || Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')||!d.enumerable)) fail('invalid_snapshot_object');
 return Object.fromEntries(Object.keys(value).sort().map(k=>{budget.units+=k.length;if(budget.units>1048576) fail('snapshot_structure_limit');return [k,canonical(descriptors[k].value,depth+1,budget)];}));
}
function freeze(value) {if(value && typeof value==='object'){for(const child of Object.values(value)) freeze(child);Object.freeze(value);}return value;}
const digest=bytes=>sha256(enc.encode(bytes));
export function createNightlyArchiveReceiptAdapter({config,capture,ledger,authorize,verifySnapshot}={}) {
 const settings=config==null?config:structuredClone(config);
 return Object.freeze({async observe(input) {
  exact(input,['namespace','sourceTable','agent','observedAt','rows','rowsJson','snapshotSha256','selection']);
  // Inspect data properties without invoking user accessors; copy all values before I/O.
  if(pilotMode(settings,input.agent)!=='shadow') fail('pilot_disabled');
  if(input.namespace!==settings.namespace || !Object.hasOwn(SELECTION,input.sourceTable) || input.selection!==SELECTION[input.sourceTable]) fail('snapshot_scope_mismatch');
  if(typeof input.observedAt!=='string' || !Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString()!==input.observedAt) fail('invalid_observed_at');
  if(typeof input.rowsJson!=='string' || input.rowsJson.length>1048576 || enc.encode(input.rowsJson).length>1048576) fail('snapshot_byte_limit');
  if(!Array.isArray(input.rows) || input.rows.length<1 || input.rows.length>500) fail('snapshot_row_limit');
  const rows=canonical(input.rows), rowsJson=JSON.stringify(rows);
  if(rowsJson!==input.rowsJson) fail('snapshot_rows_mismatch');
  // Exact serialization also rejects duplicate keys, extra whitespace or lossy JSON.
  let parsed;try {parsed=JSON.parse(input.rowsJson);} catch {fail('invalid_snapshot_json');}
  if(JSON.stringify(canonical(parsed))!==rowsJson) fail('snapshot_rows_mismatch');
  const event={namespace:input.namespace,sourceTable:input.sourceTable,agent:input.agent,selection:input.selection,
    snapshotSha256:input.snapshotSha256,observedAt:input.observedAt,rowsJson};
  const ids=new Set();
  for(const row of rows) {
   if(!row || Array.isArray(row) || !Number.isSafeInteger(row.id) || row.id<=0 || row.agent_slug!==event.agent) fail('snapshot_row_scope_mismatch');
   if(ids.has(row.id)) fail('duplicate_snapshot_row_id');ids.add(row.id);
   const required=event.sourceTable==='org_task_runs'?['task_id','due_date','status']:['role','channel','content'];
   if(required.some(k=>!Object.hasOwn(row,k)||typeof row[k]!=='string'||(k!=='content'&&(!row[k]||/[\x00-\x1f\x7f]/.test(row[k]))))) fail('invalid_snapshot_row');
  }
  const identity=JSON.stringify({namespace:event.namespace,sourceTable:event.sourceTable,agent:event.agent,rowsJson});
  if(!/^[a-f0-9]{64}$/.test(event.snapshotSha256)||await digest(identity)!==event.snapshotSha256) fail('snapshot_hash_mismatch');
  const locator=freeze({namespace:event.namespace,agent:event.agent,sourceTable:event.sourceTable,selection:event.selection,snapshotSha256:event.snapshotSha256});
  if(typeof authorize!=='function'||await authorize(freeze({...locator,operation:'archive-nightly-observation'}))!==true) fail('access_denied');
  if(typeof verifySnapshot!=='function') fail('trusted_snapshot_reader_required');
  // Independent reader resolves a trusted checkpoint by locator. Never pass expected
  // rows to a callback that could merely echo them or accept imported approval flags.
  const verified=await verifySnapshot(locator);
  exact(verified,['namespace','agent','sourceTable','selection','rowsJson']);
  if(['namespace','agent','sourceTable','selection','rowsJson'].some(k=>verified[k]!==event[k])) fail('snapshot_not_independently_verified');
  if(typeof capture?.captureD1Row!=='function'||typeof ledger?.recordReceipt!=='function') fail('archive_adapter_bindings_missing');
  const checkpoint=`nightly-snapshot:${event.snapshotSha256}`;
  const results=rows.map(row=>({sourceRowId:row.id,capture:'not-attempted',receipt:'not-attempted'}));
  // Validate/hash the complete group before the first storage write. No partial
  // acceptance caused by a later malformed row is possible.
  const bodies=await Promise.all(rows.map(async row=>{const body=JSON.stringify(row);return {body,expectedSha256:await digest(body)};}));
  for(let i=0;i<rows.length;i++) {
   const result=results[i],{body,expectedSha256}=bodies[i];
   let captured;
   try {
    captured=await capture.captureD1Row({agent:event.agent,table:event.sourceTable,checkpoint,expectedSha256},body);
    const manifest=captured?.manifest;
    if(!manifest || manifest.namespace!==event.namespace || manifest.agent_slug!==event.agent
       || manifest.source_key!==`organization-d1/${event.sourceTable}/${result.sourceRowId}`
       || manifest.source_revision!==checkpoint || manifest.content_sha256!==expectedSha256
       || !/^[a-f0-9]{64}$/.test(manifest.manifest_id)) fail('capture_result_not_verified');
    result.capture='verified';result.manifestId=manifest.manifest_id;result.captureReplay=captured.replay===true;
   } catch {result.capture='unknown';result.problem='capture_failed_or_uncertain';break;}
   try {
    const recorded=await ledger.recordReceipt({agent:event.agent,table:event.sourceTable,sourceRowId:result.sourceRowId,
      sourceRevision:checkpoint,manifestId:result.manifestId,expectedSha256});
    const receipt=recorded?.receipt;
    if(!receipt || receipt.namespace!==event.namespace || receipt.agent_slug!==event.agent || receipt.source_table!==event.sourceTable
      || receipt.source_row_id!==result.sourceRowId || receipt.source_revision!==checkpoint || receipt.manifest_id!==result.manifestId
      || receipt.source_sha256!==expectedSha256 || !/^[a-f0-9]{64}$/.test(receipt.receipt_id)) fail('receipt_result_not_verified');
    result.receipt='verified';result.receiptId=receipt.receipt_id;result.receiptReplay=recorded.replay===true;
   } catch {result.receipt='unknown';result.problem='receipt_failed_or_uncertain';break;}
  }
  return freeze({namespace:event.namespace,agent:event.agent,sourceTable:event.sourceTable,snapshotSha256:event.snapshotSha256,
    sourceRevision:checkpoint,status:results.every(r=>r.receipt==='verified')?'complete':'partial-or-unknown',rows:results,
    archiveCompleteness:'captured-export-observation-only',sourceActionsRepeated:false,cutoverReady:false});
 }});
}
