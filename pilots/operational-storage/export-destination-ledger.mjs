/** Disabled, archive-only destination bookkeeping; never mutates source rows. */
import { pilotMode, sha256 } from './store.mjs';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const CONTRACT = 'operational-json-v1';
const MARKERS = Object.freeze({org_task_runs:'exported_at', agent_chat_messages:'distilled_at'});
const fail = code => {throw Error(code);};
const hash = value => sha256(encoder.encode(value));
function text(value) { if (typeof value !== 'string' || !value || value.length>2048 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_identity'); }
function scope(agent,table,rowId) {
  pilotMode(undefined,agent);
  if (!Object.hasOwn(MARKERS,table) || !Number.isSafeInteger(rowId) || rowId<=0) fail('invalid_source_scope');
}
function request(value, keys) {
  if (!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).length!==keys.length
      || keys.some(k=>!Object.hasOwn(value,k)) || Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value'))) fail('invalid_request');
  return structuredClone(value);
}
/** Lossless numeric-token JSON parser. Reject duplicate keys rather than silently dropping them. */
function parse(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length>32*1024*1024) fail('invalid_source_bytes');
  const s=decoder.decode(bytes); let p=0;
  const ws=()=>{while (/[\t\n\r ]/.test(s[p]??'!')) p++;};
  function str() {
    const start=p++; let escape=false;
    while(p<s.length) {const c=s[p++];if(c==='"'&&!escape) return JSON.parse(s.slice(start,p)); if(c==='\\'&&!escape) escape=true; else escape=false;}
    fail('invalid_source_json');
  }
  function value(depth=0) {
    if(depth>100) fail('source_too_deep'); ws(); const c=s[p];
    if(c==='"') {const v=str();return {canonical:JSON.stringify(v),value:v};}
    if(c==='{') {
      p++; ws();const members=new Map();if(s[p]!=='}') while(true) {
        ws();if(s[p]!=='"') fail('invalid_source_json');const k=str();if(members.has(k)) fail('duplicate_json_key');
        ws();if(s[p++]!==':') fail('invalid_source_json');members.set(k,value(depth+1));ws();if(s[p]!==',') break;p++;
      }
      if(s[p++]!=='}') fail('invalid_source_json');
      return {members,canonical:object(members)};
    }
    if(c==='[') {
      p++;ws();const items=[];if(s[p]!==']') while(true) {items.push(value(depth+1));ws();if(s[p]!==',') break;p++;}
      if(s[p++]!==']') fail('invalid_source_json');return {canonical:`[${items.map(i=>i.canonical).join(',')}]`};
    }
    const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(p))?.[0];
    if(!token) fail('invalid_source_json');p+=token.length;return {canonical:token,value:JSON.parse(token)};
  }
  const root=value();ws();if(p!==s.length || !root.members) fail('invalid_source_json');return root;
}
function object(members) {return `{${[...members.keys()].sort().map(k=>`${JSON.stringify(k)}:${members.get(k).canonical}`).join(',')}}`;}
function observation(members,key) {return members.has(key)?`{"present":true,"value":${members.get(key).canonical}}`:'{"present":false}';}
async function inspect(bytes, agent, table, rowId) {
  const root=parse(bytes), m=root.members;
  if(m.get('id')?.canonical!==String(rowId) || m.get('agent_slug')?.value!==agent) fail('source_identity_mismatch');
  const required=table==='org_task_runs'?['status','task_id','due_date']:['role','channel','content'];
  if(required.some(k=>typeof m.get(k)?.value!=='string')) fail('missing_source_fields');
  const status=observation(m,'status'), marker=observation(m,MARKERS[table]);
  m.delete(MARKERS[table]);
  return {fingerprint:await hash(object(m)),status,marker};
}
export function createExportDestinationLedger({config,db,store,authorize,readCurrentSource,now=()=>new Date()}={}) {
  const settings=config==null?config:structuredClone(config);
  async function guard(agent,operation) {
    if(pilotMode(settings,agent)!=='shadow') fail('pilot_disabled');
    if(typeof authorize!=='function' || await authorize(Object.freeze({namespace:settings.namespace,agent,operation}))!==true) fail('access_denied');
    if(!db?.prepare || typeof store?.readSnapshot!=='function') fail('ledger_bindings_missing');
    return settings.namespace;
  }
  async function archive(m,namespace) {
    const snapshot=await store.readSnapshot(m.agent,m.manifestId);
    if(!snapshot) fail('archive_missing');
    const {manifest:a,bytes}=snapshot;
    const key=`organization-d1/${m.table}/${m.sourceRowId}`;
    if(a.namespace!==namespace || a.agent_slug!==m.agent || a.manifest_id!==m.manifestId || a.source_type!=='d1'
      || a.source_key!==key || a.source_revision!==m.sourceRevision || a.content_sha256!==m.expectedSha256
      || a.kind!==(m.table==='org_task_runs'?'operational-record':'communication') || a.content_type!=='application/json'
      || a.archive_only!==1 || a.integrity_state!=='bytes-verified' || a.object_key!==`${namespace}/${m.agent}/sha256/${m.expectedSha256}`
      || a.content_bytes!==bytes.length || await sha256(bytes)!==m.expectedSha256) fail('archive_identity_mismatch');
    return {manifest:a,...await inspect(bytes,m.agent,m.table,m.sourceRowId)};
  }
  async function find(namespace,agent,id) {
    return db.prepare('SELECT * FROM pilot_export_destination_receipts WHERE namespace = ? AND agent_slug = ? AND receipt_id = ?').bind(namespace,agent,id).first();
  }
  async function expected(m,namespace) {
    scope(m.agent,m.table,m.sourceRowId);text(m.sourceRevision);
    if(!/^[a-f0-9]{64}$/.test(m.manifestId)||!/^[a-f0-9]{64}$/.test(m.expectedSha256)) fail('invalid_hash');
    const a=await archive(m,namespace);
    return {namespace,receipt_id:await hash(JSON.stringify([namespace,m.agent,m.table,m.sourceRowId,m.sourceRevision])),
      agent_slug:m.agent,source_table:m.table,source_row_id:m.sourceRowId,source_revision:m.sourceRevision,
      source_key:a.manifest.source_key,source_status_json:a.status,manifest_id:m.manifestId,source_sha256:m.expectedSha256,source_content_bytes:a.manifest.content_bytes,
      content_fingerprint:a.fingerprint,fingerprint_contract:CONTRACT,archive_destination:'pilot-r2',
      archive_object_key:a.manifest.object_key,legacy_marker_json:a.marker};
  }
  const matches=(row,e)=>row && Object.entries(e).every(([k,v])=>row[k]===v);
  return Object.freeze({
    async recordReceipt(input) {
      const m=request(input,['agent','table','sourceRowId','sourceRevision','manifestId','expectedSha256']);
      const namespace=await guard(m.agent,'record-archive-receipt');
      const e=await expected(m,namespace), prior=await find(namespace,m.agent,e.receipt_id);
      if(prior) {if(!matches(prior,e)) fail('receipt_conflict');return {receipt:prior,replay:true};}
      const keys=Object.keys(e);
      // An exception can mean the insert committed. Retry the same immutable input;
      // never infer success from an uncertain response or rewrite a conflicting row.
      const result=await db.prepare(`INSERT INTO pilot_export_destination_receipts (${keys.join(',')},recorded_at) VALUES (${keys.map(()=>'?').join(',')},?) ON CONFLICT DO NOTHING`)
        .bind(...Object.values(e),now().toISOString()).run();
      if(result?.success===false) fail('receipt_write_failed');
      const receipt=await find(namespace,m.agent,e.receipt_id);
      if(!matches(receipt,e)) fail('receipt_conflict');
      return {receipt,replay:result?.meta?.changes===0};
    },
    async projectCurrent(input) {
      const m=request(input,['agent','table','sourceRowId']);scope(m.agent,m.table,m.sourceRowId);
      const namespace=await guard(m.agent,'read-archive-projection');
      if(typeof readCurrentSource!=='function') fail('current_source_reader_required');
      // Trusted adapter must independently read the current source observation,
      // not echo caller data or remove unknown fields to force parity. It returns
      // raw JSON bytes; no verified/approved flag. Export selections are not full DB rows.
      const body=await readCurrentSource(Object.freeze({...m,namespace}));
      if(body!==null && (!(body instanceof Uint8Array) || body.length>32*1024*1024)) fail('invalid_current_source_bytes');
      const current=body===null?null:await inspect(new Uint8Array(body),m.agent,m.table,m.sourceRowId);
      const result=await db.prepare('SELECT * FROM pilot_export_destination_receipts WHERE namespace = ? AND agent_slug = ? AND source_table = ? AND source_row_id = ? ORDER BY receipt_id LIMIT 33')
        .bind(namespace,m.agent,m.table,m.sourceRowId).all();
      if(result?.success===false || !Array.isArray(result?.results)) fail('receipt_query_failed');
      if(result.results.length>32) fail('projection_receipt_limit');
      let archiveBytes=0;
      for(const row of result.results) {
        if(!Number.isSafeInteger(row.source_content_bytes) || row.source_content_bytes<0) fail('receipt_integrity_failure');
        archiveBytes+=row.source_content_bytes;
      }
      if(archiveBytes>32*1024*1024) fail('projection_archive_byte_limit');
      const receipts=[];
      for(const row of result.results) {
        const e=await expected({agent:m.agent,table:m.table,sourceRowId:m.sourceRowId,sourceRevision:row.source_revision,
          manifestId:row.manifest_id,expectedSha256:row.source_sha256},namespace);
        if(!matches(row,e)) fail('receipt_integrity_failure');
        receipts.push({receiptId:row.receipt_id,manifestId:row.manifest_id,sourceRevision:row.source_revision,
          archiveDestination:row.archive_destination,archiveObjectKey:row.archive_object_key,
          archivedStatus:JSON.parse(row.source_status_json),archivedLegacyMarker:JSON.parse(row.legacy_marker_json),
          state:current?.fingerprint===row.content_fingerprint?'matches-current-content':'different-or-missing-current-content'});
      }
      const marker=current?JSON.parse(current.marker):null;
      return {agent:m.agent,sourceTable:m.table,sourceRowId:m.sourceRowId,sourcePresent:!!current,
        legacyGitExport:{marker:MARKERS[m.table],observation:marker,meaning:'raw-presence-not-export-eligibility',state:!current?'source-missing':marker.present&&marker.value!==null?'legacy-marker-present':'legacy-marker-absent',deliveryVerified:false},
        archiveState:receipts.some(r=>r.state==='matches-current-content')?'current-content-archived':receipts.length?'historical-only':'no-receipt',receipts,
        observationOnly:true,archiveCompleteness:'captured-export-observation-only',
        currentMatchMeaning:'all-observed-fields-except-table-destination-marker',
        consistentDatabaseBackupVerified:false,legacyDashboardCountsUnchanged:true,cutoverReady:false};
    },
  });
}
