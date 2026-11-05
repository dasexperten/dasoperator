/** Observer-side writer adapter. Records snapshots, never repeats the source action. */
import { PILOT_AGENTS, pilotMode, sha256 } from './store.mjs';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const TABLES = new Set(['org_task_runs', 'agent_chat_messages', 'ugc_creators', 'angela_article_queue']);
const ARTIFACTS = /\.(?:md|txt|json|jsonl|csv|tsv|jpg|jpeg|png|webp|svg|pdf)$/i;
const SENSITIVE_OR_RULES = /(?:^|[._-])(?:readme|agents|claude|charter|voice|learning|rules?|connections?|secrets?|credentials?|passwords?|tokens?|cookies?|access)(?:[._-]|$)/i;
const fail = message => { throw Error(message); };
function metadata(value, allowed, required) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).some(k=>!allowed.includes(k))
      || required.some(k=>!Object.hasOwn(value,k))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(p=>!Object.hasOwn(p,'value'))) fail('invalid_capture_metadata');
  return structuredClone(value);
}
function inputBytes(value) {
  const result = typeof value === 'string' ? encoder.encode(value)
    : value instanceof Uint8Array ? new Uint8Array(value) : null;
  if (!result || result.byteLength > 32*1024*1024) fail('invalid_capture_bytes');
  return result;
}
function string(value, name) { if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) fail(`invalid_${name}`); }
function id(value) { if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_source_row_id'); }
function fields(value,names) { if (names.some(name=>!Object.hasOwn(value,name))) fail('missing_source_fields'); }
async function gitBlobSha1(bytes) {
  const header=encoder.encode(`blob ${bytes.length}\0`);
  const object=new Uint8Array(header.length+bytes.length);object.set(header);object.set(bytes,header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1',object))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function sourcePath(path,agent) {
  string(path,'source_path');
  if (path.includes('\\') || path.split('/').some(p=>!p || p==='.' || p==='..') || !path.startsWith(`agents/${agent}/`)) fail('invalid_source_path');
  const relative=path.slice(`agents/${agent}/`.length);
  if (['MEMORY.md','MEMORY_RAW.md'].includes(relative)) return 'working-memory';
  const parts=relative.split('/');
  if (parts.slice(1).some(p=>p.startsWith('.') || SENSITIVE_OR_RULES.test(p))) fail('source_path_requires_review');
  if (['social-outbox','offer-outbox'].includes(parts[0]) && agent==='angela' && parts.length>1 && /\.json$/i.test(path)) return 'queue-snapshot';
  if (parts[0]!=='data' || parts.length<2 || !ARTIFACTS.test(path)
      || parts.slice(1).some(p=>p.startsWith('.') || SENSITIVE_OR_RULES.test(p))) fail('source_path_requires_review');
  return /\.(?:jpg|jpeg|png|webp|svg|pdf)$/i.test(path) ? 'evidence' : 'operational-record';
}
/** Pure shared path policy; no verification, authorization or storage I/O. */
export function classifyGithubSourcePath(path,agent) {
  if (!PILOT_AGENTS.includes(agent)) fail('unsupported_agent');
  return sourcePath(path,agent);
}
function originalGithubUrl(repository,commit,path) {
  return `https://github.com/${repository}/blob/${commit}/${path.split('/').map(p=>encodeURIComponent(p).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
}

/**
 * sourceVerifier is REQUIRED and trusted. It independently checks the snapshot
 * against a reviewed pinned Git blob or consistent D1 export checkpoint. It is
 * not an approved:true field from source data. Store authorization still applies.
 * No legacy write callback exists: source writer and its result remain untouched.
 */
export function createOperationalCapture({config,store,sourceVerifier}={}) {
  const settings=config==null?config:structuredClone(config);
  function enabled(agent) {
    if (!PILOT_AGENTS.includes(agent)) fail('unsupported_agent');
    return pilotMode(settings,agent)==='shadow';
  }
  async function save(descriptor,bytes,verification) {
    if (!/^[a-f0-9]{64}$/.test(descriptor.expectedSha256 || '') || await sha256(bytes)!==descriptor.expectedSha256) fail('capture_hash_mismatch');
    if (typeof sourceVerifier!=='function' || await sourceVerifier(Object.freeze(structuredClone({...descriptor,verification})))!==true) fail('source_not_verified');
    if (typeof store?.importSnapshot!=='function') fail('pilot_store_missing');
    // The verifier receives a copy, so it cannot change the descriptor to import.
    return store.importSnapshot(descriptor,bytes);
  }
  return Object.freeze({
    async captureEvidence(input,body) {
      const m=metadata(input,['agent','sourceType','sourceKey','revision','expectedSha256','contentType','originalUrl'],
        ['agent','sourceType','sourceKey','revision','expectedSha256','contentType']);
      if (!enabled(m.agent)) return {skipped:'pilot_disabled',agent:m.agent};
      const bytes=inputBytes(body);
      if (!['r2','local-export'].includes(m.sourceType)) fail('invalid_evidence_source');
      string(m.sourceKey,'evidence_source_key'); string(m.revision,'evidence_revision');
      const source={type:m.sourceType,key:m.sourceKey,revision:m.revision};
      if (Object.hasOwn(m,'originalUrl')) source.originalUrl=m.originalUrl;
      return save({agent:m.agent,kind:'evidence',contentType:m.contentType,expectedSha256:m.expectedSha256,source},bytes,{archiveOnly:true});
    },
    async captureGithubFile(input,body) {
      const m=metadata(input,['agent','repository','commit','path','gitBlobSha1','expectedSha256','contentType'],
        ['agent','repository','commit','path','gitBlobSha1','expectedSha256','contentType']);
      if (!enabled(m.agent)) return {skipped:'pilot_disabled',agent:m.agent};
      const bytes=inputBytes(body);
      if (m.repository!=='dasexperten/organizacia' || !/^[a-f0-9]{40}$/.test(m.commit||'')
          || !/^[a-f0-9]{40}$/.test(m.gitBlobSha1||'')) fail('invalid_github_source');
      const kind=sourcePath(m.path,m.agent);
      if (await gitBlobSha1(bytes)!==m.gitBlobSha1) fail('git_blob_mismatch');
      return save({agent:m.agent,kind,contentType:m.contentType,expectedSha256:m.expectedSha256,
        source:{type:'github',key:`${m.repository}:${m.path}`,revision:m.commit,
          originalUrl:originalGithubUrl(m.repository,m.commit,m.path)}},bytes,{gitBlobSha1:m.gitBlobSha1});
    },
    async captureD1Row(input,body) {
      const m=metadata(input,['agent','table','checkpoint','expectedSha256','originalUrl'],['agent','table','checkpoint','expectedSha256']);
      if (!enabled(m.agent)) return {skipped:'pilot_disabled',agent:m.agent};
      const bytes=inputBytes(body);
      if (!TABLES.has(m.table)) fail('unsupported_source_table');
      string(m.checkpoint,'source_checkpoint');
      let row;try { row=JSON.parse(decoder.decode(bytes)); } catch { fail('invalid_source_json'); }
      if (!row || Array.isArray(row) || typeof row!=='object') fail('invalid_source_row');
      fields(row,['id']);
      // ERP creator IDs are stable opaque strings (stableId('ugc', ...)),
      // while the organization tables and queue use integer primary keys.
      if (m.table==='ugc_creators') string(row.id,'creator_id');
      else id(row.id);
      let kind='operational-record', database='organization-d1';
      if (['org_task_runs','agent_chat_messages'].includes(m.table)) {
        fields(row,['agent_slug']);
        if (row.agent_slug!==m.agent) fail('source_agent_mismatch');
        if (m.table==='org_task_runs') {
          fields(row,['task_id','due_date','status']);
          string(row.task_id,'task_id'); string(row.due_date,'due_date'); string(row.status,'status');
        } else {
          fields(row,['role','channel','content']);
          kind='communication';string(row.role,'chat_role');string(row.channel,'chat_channel');
          if (typeof row.content!=='string') fail('invalid_chat_content');
        }
      } else if (m.table==='ugc_creators') {
        if (m.agent!=='diana-helios') fail('source_agent_mismatch');
        fields(row,['normalized_handle','notes']);
        database='erp-d1';string(row.normalized_handle,'creator_handle');
        if (row.notes!==null && typeof row.notes!=='string') fail('invalid_creator_notes');
      } else {
        fields(row,['version','data']);
        if (m.agent!=='angela' || row.id!==1 || !Number.isSafeInteger(row.version) || row.version<0 || typeof row.data!=='string') fail('invalid_queue_snapshot');
        let state;try {state=JSON.parse(row.data);} catch {fail('invalid_queue_snapshot');}
        if (!state || !['initializedAt','seen','articles'].every(k=>Object.hasOwn(state,k))
            || !Array.isArray(state.seen) || !Array.isArray(state.articles)) fail('invalid_queue_snapshot');
        kind='queue-snapshot';
      }
      const source={type:'d1',key:`${database}/${m.table}/${encodeURIComponent(String(row.id))}`,revision:m.checkpoint};
      if (Object.hasOwn(m,'originalUrl')) source.originalUrl=m.originalUrl;
      return save({agent:m.agent,kind,contentType:'application/json',expectedSha256:m.expectedSha256,source},bytes,{checkpoint:m.checkpoint});
    },
  });
}
