/** Local, read-only archive reconciliation. Never a source/action writer or cutover gate. */
import { PILOT_AGENTS, pilotMode, sha256 } from './store.mjs';
import { classifyGithubSourcePath } from './capture.mjs';

const encoder = new TextEncoder();
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 10000;
const SOURCES = ['github', 'd1', 'r2', 'local-export'];
const KINDS = ['working-memory', 'communication', 'report', 'evidence', 'queue-snapshot', 'approval-snapshot', 'operational-record'];
const MANIFEST_FIELDS = ['namespace', 'manifest_id', 'agent_slug', 'source_type', 'source_key', 'source_revision',
  'original_url', 'kind', 'content_type', 'content_sha256', 'content_bytes', 'object_key', 'archive_only', 'integrity_state', 'imported_at'];
const IDENTITY_FIELDS = ['agent', 'sourceType', 'sourceKey', 'sourceRevision'];
const RECORD_FIELDS = [...IDENTITY_FIELDS, 'manifestId', 'kind', 'contentType', 'sha256', 'contentBytes', 'originalUrl', 'archiveExpectation'];
const fail = code => { throw Error(code); };
function exact(value, keys, code, required = keys, allowNullPrototype = false) {
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && !(allowNullPrototype && Object.getPrototypeOf(value) === null))
      || Reflect.ownKeys(value).some(k => typeof k !== 'string' || !keys.includes(k))
      || required.some(k => !Object.hasOwn(value, k))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) fail(code);
}
function string(value, code, max = 2048) {
  if (typeof value !== 'string' || !value || value.length > max || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) fail(code);
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid_snapshot_time');
}
function count(value, code, max = MAX_RECORDS) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(code);
}
function bytes(value) {
  let size;
  try { size = typedArrayByteLength.call(value); } catch { fail('invalid_snapshot_bytes'); }
  if (!(value instanceof Uint8Array) || size > MAX_BYTES) fail('invalid_snapshot_bytes');
  const copy = new Uint8Array(value);
  if (typedArrayByteLength.call(copy) !== size) fail('invalid_snapshot_bytes');
  return copy;
}
function list(value, code, max = MAX_RECORDS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > max || Object.keys(value).length !== value.length
      || Reflect.ownKeys(value).length !== value.length + 1
      || Reflect.ownKeys(value).some(k => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= value.length))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail(code);
}
const key = row => JSON.stringify(IDENTITY_FIELDS.map(field => row[field]));
const idFor = row => sha256(encoder.encode(JSON.stringify([row.agent, row.sourceType, row.sourceKey, row.sourceRevision])));
const scopeKey = s => JSON.stringify([s.agent, s.sourceType, s.sourcePrefix]);
const inScope = (row, scope) => row.agent === scope.agent && row.sourceType === scope.sourceType && row.sourceKey.startsWith(scope.sourcePrefix);
function sourceIdentity(row) {
  if (!PILOT_AGENTS.includes(row.agent) || !SOURCES.includes(row.sourceType)) fail('invalid_source_scope');
  string(row.sourceKey, 'invalid_source_key'); string(row.sourceRevision, 'invalid_source_revision', 256);
}
function scopePolicy(s) {
  if (!PILOT_AGENTS.includes(s.agent) || !SOURCES.includes(s.sourceType)) fail('invalid_inventory_scope');
  string(s.sourcePrefix, 'invalid_source_prefix'); string(s.revision, 'invalid_source_revision', 256);
  if (s.sourceType === 'github') {
    const root = `dasexperten/organizacia:agents/${s.agent}/`;
    if (![root, `${root}data/`, `${root}social-outbox/`, `${root}offer-outbox/`].includes(s.sourcePrefix)
        || !/^[a-f0-9]{40}$/.test(s.revision)) fail('invalid_github_scope');
    if (s.agent !== 'angela' && /(?:social|offer)-outbox\/$/.test(s.sourcePrefix)) fail('invalid_github_scope');
  }
  if (s.sourceType === 'd1') {
    const allowed = ['organization-d1/org_task_runs/', 'organization-d1/agent_chat_messages/',
      s.agent === 'angela' ? 'organization-d1/angela_article_queue/' : 'erp-d1/ugc_creators/'];
    if (!allowed.includes(s.sourcePrefix)) fail('invalid_d1_scope');
  }
}
function recordPolicy(r, s) {
  sourceIdentity(r);
  if (r.sourceRevision !== s.revision) fail('inventory_revision_mismatch');
  if (r.sourceType === 'github') {
    const path = r.sourceKey.slice('dasexperten/organizacia:'.length);
    if (classifyGithubSourcePath(path, r.agent) !== r.kind) fail('inventory_kind_mismatch');
    const url = `https://github.com/dasexperten/organizacia/blob/${r.sourceRevision}/${path.split('/').map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
    if (r.originalUrl !== url) fail('inventory_url_mismatch');
  } else if (r.sourceType === 'd1') {
    const suffix = r.sourceKey.slice(s.sourcePrefix.length);
    if (s.sourcePrefix === 'erp-d1/ugc_creators/') {
      let decoded; try { decoded = decodeURIComponent(suffix); } catch { fail('invalid_source_id'); }
      string(decoded, 'invalid_source_id');
      if (encodeURIComponent(decoded) !== suffix || r.kind !== 'operational-record') fail('invalid_source_id');
    } else {
      if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) fail('invalid_source_id');
      const table = s.sourcePrefix.split('/')[1];
      const expectedKind = table === 'agent_chat_messages' ? 'communication' : table === 'angela_article_queue' ? 'queue-snapshot' : 'operational-record';
      if (r.kind !== expectedKind || (table === 'angela_article_queue' && suffix !== '1')) fail('inventory_kind_mismatch');
    }
  } else if (r.kind !== 'evidence') fail('inventory_kind_mismatch');
}
function snapshotCopy(input) {
  exact(input, ['checkpoint', 'asOf', 'records'], 'invalid_source_snapshot');
  string(input.checkpoint, 'invalid_source_checkpoint', 256); iso(input.asOf);
  list(input.records, 'invalid_source_records');
  let total = 0;
  const records = input.records.map(row => {
    exact(row, [...IDENTITY_FIELDS, 'bytes'], 'invalid_source_record'); sourceIdentity(row);
    const body = bytes(row.bytes); total += body.byteLength;
    if (total > MAX_BATCH_BYTES) fail('source_batch_too_large');
    return { ...row, bytes: body };
  });
  return { checkpoint: input.checkpoint, asOf: input.asOf, records };
}
function inventoryFrom(body) {
  let value; try { value = JSON.parse(decoder.decode(body)); } catch { fail('invalid_inventory_json'); }
  exact(value, ['version', 'namespace', 'checkpoint', 'asOf', 'scopes', 'records'], 'invalid_inventory');
  if (value.version !== 1) fail('invalid_inventory_version');
  string(value.checkpoint, 'invalid_source_checkpoint', 256); iso(value.asOf);
  list(value.scopes, 'invalid_inventory_scopes', 16); list(value.records, 'invalid_inventory_records');
  if (!value.scopes.length) fail('empty_inventory_scope');
  for (const s of value.scopes) {
    exact(s, ['agent', 'sourceType', 'sourcePrefix', 'revision', 'expectedCount'], 'invalid_inventory_scope');
    scopePolicy(s); count(s.expectedCount, 'invalid_expected_count');
  }
  for (let a = 0; a < value.scopes.length; a++) for (let b = a + 1; b < value.scopes.length; b++) {
    const x = value.scopes[a], y = value.scopes[b];
    if (x.agent === y.agent && x.sourceType === y.sourceType
        && (x.sourcePrefix.startsWith(y.sourcePrefix) || y.sourcePrefix.startsWith(x.sourcePrefix))) fail('overlapping_inventory_scopes');
  }
  const seen = new Set();
  for (const r of value.records) {
    exact(r, RECORD_FIELDS, 'invalid_inventory_record'); sourceIdentity(r);
    if (!HASH.test(r.manifestId) || !HASH.test(r.sha256) || !KINDS.includes(r.kind)
        || !['required', 'pending'].includes(r.archiveExpectation)) fail('invalid_inventory_record');
    count(r.contentBytes, 'invalid_content_size', MAX_BYTES);
    string(r.contentType, 'invalid_content_type', 128);
    if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:; ?charset=utf-8)?$/.test(r.contentType)) fail('invalid_content_type');
    if (r.originalUrl !== null) {
      string(r.originalUrl, 'invalid_original_url', 4096);
      let url; try { url = new URL(r.originalUrl); } catch { fail('invalid_original_url'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_original_url');
    }
    const matches = value.scopes.filter(s => inScope(r, s));
    if (matches.length !== 1) fail('inventory_scope_mismatch');
    recordPolicy(r, matches[0]);
    if (seen.has(key(r))) fail('duplicate_inventory_record'); seen.add(key(r));
  }
  for (const s of value.scopes) if (value.records.filter(r => inScope(r, s)).length !== s.expectedCount) fail('inventory_count_mismatch');
  return value;
}
function expectedManifest(namespace, r) {
  return { namespace, manifest_id: r.manifestId, agent_slug: r.agent, source_type: r.sourceType,
    source_key: r.sourceKey, source_revision: r.sourceRevision, original_url: r.originalUrl, kind: r.kind,
    content_type: r.contentType, content_sha256: r.sha256, content_bytes: r.contentBytes,
    object_key: `${namespace}/${r.agent}/sha256/${r.sha256}`, archive_only: 1, integrity_state: 'bytes-verified' };
}
function baseReport() {
  return { readOnly: true, cutoverReady: false, source: { status: 'not_checked', actionOutcomes: 'not_assessed', legacyExportMarkers: 'not_assessed' },
    archive: { status: 'not_checked', counts: { expected: 0, matched: 0, pending: 0, missing: 0, conflicting: 0, unavailable: 0, unexpected: 0, historical: 0, skipped: 0 } }, records: [], issues: [] };
}

/**
 * trustedProvenance must come from a separately verified, authorized snapshot
 * inventory, never from the payload being compared. Its digest pins the exact
 * inventory JSON bytes. It grants no archive access; authorize is independent.
 * db is a read-only D1-style prepare/bind/all adapter; bucket only needs get.
 */
export function createOperationalReconciliation(options = {}) {
  exact(options, ['config', 'trustedProvenance', 'db', 'bucket', 'authorize'], 'invalid_reconciliation_options', []);
  const ownOption = field => Object.hasOwn(options, field) ? options[field] : undefined;
  const rawConfig = ownOption('config');
  if (rawConfig != null) {
    exact(rawConfig, ['namespace', 'agents'], 'invalid_pilot_config');
    exact(rawConfig.agents, PILOT_AGENTS, 'invalid_pilot_agents', []);
  }
  const config = rawConfig == null ? null : structuredClone(rawConfig);
  const enabled = new Set(PILOT_AGENTS.filter(agent => pilotMode(config, agent) === 'shadow'));
  const db = ownOption('db'), bucket = ownOption('bucket'), authorize = ownOption('authorize');
  let pin = null;
  if (enabled.size) {
    exact(ownOption('trustedProvenance'), ['inventorySha256', 'namespace', 'checkpoint', 'asOf'], 'trusted_provenance_required');
    pin = structuredClone(ownOption('trustedProvenance'));
    if (!HASH.test(pin.inventorySha256) || pin.namespace !== config.namespace) fail('invalid_trusted_provenance');
    string(pin.checkpoint, 'invalid_source_checkpoint', 256); iso(pin.asOf);
  }
  return Object.freeze({
    async reconcile(input) {
      const report = baseReport();
      if (!enabled.size) return { ...report, skipped: 'pilot_disabled' };
      exact(input, ['inventoryBytes', 'sourceSnapshot'], 'invalid_reconciliation_input');
      // Copy every caller-owned buffer before the first await.
      const inventoryBytes = bytes(input.inventoryBytes), source = snapshotCopy(input.sourceSnapshot);
      if (await sha256(inventoryBytes) !== pin.inventorySha256) fail('inventory_digest_mismatch');
      const inventory = inventoryFrom(inventoryBytes);
      if (inventory.namespace !== pin.namespace || inventory.checkpoint !== pin.checkpoint || inventory.asOf !== pin.asOf) fail('inventory_provenance_mismatch');
      for (const r of inventory.records) if (await idFor(r) !== r.manifestId) fail('inventory_manifest_id_mismatch');
      const selected = inventory.records.filter(r => enabled.has(r.agent));
      const scopes = inventory.scopes.filter(s => enabled.has(s.agent));
      if (!scopes.length) return { ...report, skipped: 'no_enabled_inventory_scopes' };
      report.namespace = pin.namespace; report.inventorySha256 = pin.inventorySha256;
      report.source.checkpoint = pin.checkpoint; report.source.asOf = pin.asOf;
      report.archive.counts.expected = selected.length;
      report.archive.counts.skipped = inventory.records.length - selected.length;
      report.records = selected.map(r => ({ agent: r.agent, sourceType: r.sourceType, sourceKey: r.sourceKey,
        sourceRevision: r.sourceRevision, manifestId: r.manifestId, source: { status: 'matched' }, archive: { status: 'not_checked' } }));
      const results = new Map(report.records.map(r => [key(r), r]));
      if (source.checkpoint !== pin.checkpoint) report.issues.push({ code: 'source_checkpoint_mismatch' });
      if (source.asOf !== pin.asOf) report.issues.push({ code: 'source_time_mismatch' });
      const expected = new Map(inventory.records.map(r => [key(r), r]));
      const observed = new Map();
      for (const r of source.records) {
        const identity = key(r);
        if (observed.has(identity)) report.issues.push({ code: 'duplicate_source_record' });
        observed.set(identity, r);
        if (!expected.has(identity)) report.issues.push({ code: 'unexpected_source_identity' });
      }
      for (const r of selected) {
        const actual = observed.get(key(r)), result = results.get(key(r));
        if (!actual) {
          result.source = { status: 'missing', code: 'source_record_missing' };
          report.issues.push({ code: 'source_record_missing', manifestId: r.manifestId });
        } else if (actual.bytes.byteLength !== r.contentBytes || await sha256(actual.bytes) !== r.sha256) {
          result.source = { status: 'conflicting', code: 'source_bytes_mismatch' };
          report.issues.push({ code: 'source_bytes_mismatch', manifestId: r.manifestId });
        }
      }
      if (report.issues.length) {
        report.source.status = 'blocked';
        // Even individually equal bytes cannot establish a consistent snapshot.
        for (const r of report.records) if (r.source.status === 'matched') r.source = { status: 'unverified', code: 'source_snapshot_blocked' };
        return report;
      }
      report.source.status = 'matched';
      const markScope = (s, status, code) => {
        for (const r of selected.filter(r => inScope(r, s))) results.get(key(r)).archive = { status, code };
        report.issues.push({ code, scope: scopeKey(s) });
      };
      const authorizedScopes = [];
      for (const s of scopes) {
        // Authorization is checked for each exact scope, including empty scopes.
        try {
          if (typeof authorize !== 'function' || await authorize(Object.freeze({ namespace: pin.namespace,
            agent: s.agent, sourceType: s.sourceType, sourcePrefix: s.sourcePrefix, revision: s.revision,
            operation: 'reconcile-read' })) !== true) { markScope(s, 'unavailable', 'archive_access_denied'); continue; }
        } catch { markScope(s, 'unavailable', 'archive_authorization_unavailable'); continue; }
        authorizedScopes.push(s);
      }
      let allRows = null;
      if (authorizedScopes.length) {
        let archiveResults, readSucceeded = false;
        try {
          if (typeof db?.prepare !== 'function' || typeof bucket?.get !== 'function') fail('missing_bindings');
          // A single SELECT fixes the complete manifest cohort at one SQLite/D1
          // statement snapshot. Literal prefixes avoid LIKE wildcard expansion.
          // At most 16 scopes use 65 parameters, below D1's 100-parameter limit.
          const clauses = authorizedScopes.map(() => '(agent_slug = ? AND source_type = ? AND substr(source_key, 1, ?) = ?)');
          const args = authorizedScopes.flatMap(s => [s.agent, s.sourceType, [...s.sourcePrefix].length, s.sourcePrefix]);
          const answer = await db.prepare(`SELECT * FROM pilot_operational_manifests
            WHERE namespace = ? AND (${clauses.join(' OR ')}) ORDER BY manifest_id`).bind(pin.namespace, ...args).all();
          if (!answer || (Object.getPrototypeOf(answer) !== Object.prototype && Object.getPrototypeOf(answer) !== null)) fail('read_failed');
          const fields = Object.getOwnPropertyDescriptors(answer);
          if (!Object.hasOwn(fields, 'success') || !Object.hasOwn(fields.success, 'value') || fields.success.value !== true
              || !Object.hasOwn(fields, 'results') || !Object.hasOwn(fields.results, 'value')) fail('read_failed');
          archiveResults = fields.results.value; readSucceeded = true;
        } catch { for (const s of authorizedScopes) markScope(s, 'unavailable', 'archive_inventory_unavailable'); }
        if (readSucceeded) {
          try {
            list(archiveResults, 'invalid_archive_listing');
            allRows = archiveResults.map(row => {
              exact(row, MANIFEST_FIELDS, 'invalid_archive_manifest', MANIFEST_FIELDS, true);
              const identity = { agent: row.agent_slug, sourceType: row.source_type, sourceKey: row.source_key, sourceRevision: row.source_revision };
              sourceIdentity(identity);
              if (row.namespace !== pin.namespace || authorizedScopes.filter(s => inScope(identity, s)).length !== 1) fail('foreign_archive_scope');
              return structuredClone(row);
            });
          } catch {
            allRows = null;
            for (const s of authorizedScopes) markScope(s, 'conflicting', 'archive_inventory_conflict');
          }
        }
      }
      for (const s of allRows === null ? [] : authorizedScopes) {
        const rowsForScope = selected.filter(r => inScope(r, s));
        const rows = allRows.filter(row => inScope({ agent: row.agent_slug, sourceType: row.source_type, sourceKey: row.source_key }, s));
        const markAll = (status, code) => markScope(s, status, code);
        const byId = new Map(), identitySeen = new Set(); let badListing = false;
        for (const row of rows) {
          const identity = { agent: row.agent_slug, sourceType: row.source_type, sourceKey: row.source_key, sourceRevision: row.source_revision };
          try {
            sourceIdentity(identity); iso(row.imported_at);
            if (!inScope(identity, s) || row.namespace !== pin.namespace || !HASH.test(row.content_sha256)
                || row.archive_only !== 1 || row.integrity_state !== 'bytes-verified'
                || row.manifest_id !== await idFor(identity)
                || row.object_key !== `${pin.namespace}/${s.agent}/sha256/${row.content_sha256}`
                || byId.has(row.manifest_id) || identitySeen.has(key(identity))) fail('bad_listing');
            count(row.content_bytes, 'invalid_size', MAX_BYTES);
          } catch { badListing = true; break; }
          byId.set(row.manifest_id, row); identitySeen.add(key(identity));
        }
        if (badListing) { markAll('conflicting', 'archive_inventory_conflict'); continue; }
        const expectedIds = new Set(rowsForScope.map(r => r.manifestId));
        for (const row of rows) {
          if (row.source_revision !== s.revision) report.archive.counts.historical++;
          else if (!expectedIds.has(row.manifest_id)) {
            report.archive.counts.unexpected++;
            report.issues.push({ code: 'unexpected_archive_identity', scope: scopeKey(s), manifestId: row.manifest_id });
          }
        }
        for (const r of rowsForScope) {
          const target = results.get(key(r)), row = byId.get(r.manifestId);
          if (!row) {
            target.archive = { status: r.archiveExpectation === 'pending' ? 'pending' : 'missing', code: 'archive_manifest_missing' };
            continue;
          }
          if (Object.entries(expectedManifest(pin.namespace, r)).some(([field, value]) => row[field] !== value)) {
            target.archive = { status: 'conflicting', code: 'archive_manifest_conflict' }; continue;
          }
          let object, body;
          try { object = await bucket.get(row.object_key); }
          catch { target.archive = { status: 'unavailable', code: 'archive_blob_unavailable' }; continue; }
          if (object === null || object === undefined) { target.archive = { status: 'missing', code: 'archive_blob_missing' }; continue; }
          try {
            if (typeof object.arrayBuffer !== 'function' || !Number.isSafeInteger(object.size)
                || object.size !== r.contentBytes || object.size > MAX_BYTES) fail('invalid_blob');
          } catch { target.archive = { status: 'conflicting', code: 'archive_blob_metadata_conflict' }; continue; }
          try {
            const raw = await object.arrayBuffer();
            if (!(raw instanceof ArrayBuffer)) fail('invalid_blob_body');
            body = bytes(new Uint8Array(raw));
          }
          catch { target.archive = { status: 'unavailable', code: 'archive_blob_read_unavailable' }; continue; }
          target.archive = body.byteLength === r.contentBytes && await sha256(body) === r.sha256
            ? { status: 'matched', code: 'archive_bytes_match' }
            : { status: 'conflicting', code: 'archive_blob_hash_conflict' };
        }
      }
      for (const r of report.records) report.archive.counts[r.archive.status]++;
      const counts = report.archive.counts;
      report.archive.status = report.issues.length || counts.conflicting || counts.unavailable ? 'blocked'
        : counts.pending || counts.missing ? 'incomplete' : 'matched';
      return report;
    },
  });
}
