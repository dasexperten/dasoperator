/** Isolated candidate heads only. No active loader, writer, HTTP route or network. */
import { PILOT_AGENTS, pilotMode, sha256 } from './store.mjs';
const NAMES = Object.freeze(['MEMORY.md', 'MEMORY_RAW.md']);
const HASH = /^[0-9a-f]{64}$/;
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();
const fail = code => { throw Error(code); };
function metadata(value, keys, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(k => !keys.includes(k))
    || required.some(k => !Object.hasOwn(value, k))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail('invalid_head_request');
  return structuredClone(value);
}
function scope(input) {
  if (!PILOT_AGENTS.includes(input.agent)) fail('unsupported_agent');
  if (!NAMES.includes(input.name)) fail('unsupported_memory_name');
}
function number(value, max = MAX_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function request(input, action) {
  const keys = ['agent', 'name', 'expectedVersion', 'expectedFence', 'requestId'];
  if (action !== 'fence') keys.push('manifestId');
  const value = metadata(input, keys);
  scope(value);
  if (!number(value.expectedVersion, MAX_INTEGER - 1)) fail('invalid_expected_version');
  if (!number(value.expectedFence, action === 'fence' ? MAX_INTEGER - 1 : MAX_INTEGER)) fail('invalid_expected_fence');
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId)) fail('invalid_request_id');
  if (action !== 'fence' && (typeof value.manifestId !== 'string' || !HASH.test(value.manifestId))) fail('invalid_manifest_id');
  return value;
}
function matchesRequest(row, value, action) {
  return row.action === action && row.expected_version === value.expectedVersion
    && row.expected_fence === value.expectedFence && row.request_id === value.requestId
    && (action === 'fence' || row.manifest_id === value.manifestId);
}

/**
 * authorize is REQUIRED, trusted, and bound to an authenticated identity. It
 * grants per-agent/name head operations independently from store authorization.
 * db must be the same separate pilot D1 database as the immutable store; use a
 * primary binding or sequentially consistent session. No credentials are created.
 */
export function createMemoryHead({ config, db, store, authorize, now = () => new Date() } = {}) {
  // Validate before cloning, so accessors cannot execute while capturing settings.
  for (const agent of PILOT_AGENTS) pilotMode(config, agent);
  const settings = config == null ? config : structuredClone(config);
  async function guard(value, operation) {
    if (pilotMode(settings, value.agent) !== 'shadow') fail('pilot_disabled');
    const context = Object.freeze({ namespace: settings.namespace, ...value, operation });
    if (typeof authorize !== 'function' || await authorize(context) !== true) fail('access_denied');
    if (!db?.prepare || typeof store?.readSnapshot !== 'function') fail('head_bindings_missing');
    return settings.namespace;
  }
  async function head(namespace, agent, name) {
    return db.prepare(`SELECT * FROM pilot_working_memory_heads
      WHERE namespace = ? AND agent_slug = ? AND memory_name = ?`).bind(namespace, agent, name).first();
  }
  async function priorRequest(namespace, value) {
    return db.prepare(`SELECT * FROM pilot_working_memory_transitions
      WHERE namespace = ? AND agent_slug = ? AND memory_name = ? AND request_id = ?`)
      .bind(namespace, value.agent, value.name, value.requestId).first();
  }
  async function verifySnapshot(namespace, agent, name, id, expectedHash) {
    const result = await store.readSnapshot(agent, id);
    if (!result) fail('head_snapshot_missing');
    const { manifest: m, bytes } = result;
    const key = `dasexperten/organizacia:agents/${agent}/${name}`;
    if (!m || m.namespace !== namespace || m.agent_slug !== agent || m.manifest_id !== id
      || m.kind !== 'working-memory' || m.source_type !== 'github' || m.source_key !== key
      || typeof m.source_revision !== 'string' || !/^[0-9a-f]{40}$/.test(m.source_revision)
      || !HASH.test(m.content_sha256) || m.object_key !== `${namespace}/${agent}/sha256/${m.content_sha256}`
      || m.archive_only !== 1 || m.integrity_state !== 'bytes-verified'
      || (expectedHash !== undefined && m.content_sha256 !== expectedHash)) fail('head_target_invalid');
    if (!(bytes instanceof Uint8Array) || !number(m.content_bytes, 32 * 1024 * 1024)
      || bytes.byteLength !== m.content_bytes || await sha256(bytes) !== m.content_sha256) fail('head_snapshot_integrity_failure');
    const sourceId = await sha256(encoder.encode(JSON.stringify([agent, 'github', key, m.source_revision])));
    if (sourceId !== id) fail('head_target_invalid');
    // Pin to the manifest in THIS D1 database, even if the injected reader was
    // accidentally constructed against a different pilot store.
    const local = await db.prepare(`SELECT * FROM pilot_operational_manifests
      WHERE namespace = ? AND agent_slug = ? AND manifest_id = ?`).bind(namespace, agent, id).first();
    if (!local || Object.keys(local).some(k => local[k] !== m[k])
      || Object.keys(m).some(k => m[k] !== local[k])) fail('head_manifest_store_mismatch');
    return { manifest: m, bytes: new Uint8Array(bytes) };
  }
  async function validateTransition(row, namespace, agent, name) {
    if (!row || row.namespace !== namespace || row.agent_slug !== agent || row.memory_name !== name
      || !number(row.version) || row.version < 1 || row.expected_version !== row.version - 1
      || !number(row.fence) || !number(row.expected_fence) || !HASH.test(row.manifest_id)
      || !HASH.test(row.content_sha256) || !['advance', 'rollback', 'fence'].includes(row.action)
      || typeof row.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.request_id)
      || typeof row.committed_at !== 'string' || !Number.isFinite(Date.parse(row.committed_at))) fail('head_history_integrity_failure');
    const previous = row.version > 1 ? await db.prepare(`SELECT * FROM pilot_working_memory_transitions
      WHERE namespace = ? AND agent_slug = ? AND memory_name = ? AND version = ?`)
      .bind(namespace, agent, name, row.version - 1).first() : null;
    if ((row.version > 1 && !previous) || row.previous_manifest_id !== (previous?.manifest_id ?? null)
      || row.expected_fence !== (previous?.fence ?? 0)
      || row.fence !== row.expected_fence + (row.action === 'fence' ? 1 : 0)
      || (row.action === 'fence' && (!previous || row.manifest_id !== previous.manifest_id))) fail('head_history_integrity_failure');
    if (row.action === 'rollback' || row.action === 'advance') {
      const earlier = await db.prepare(`SELECT version FROM pilot_working_memory_transitions
        WHERE namespace = ? AND agent_slug = ? AND memory_name = ? AND manifest_id = ? AND version < ? LIMIT 1`)
        .bind(namespace, agent, name, row.manifest_id, row.version).first();
      if ((row.action === 'rollback' && !earlier) || (row.action === 'advance' && earlier)) fail('head_history_integrity_failure');
    }
  }
  async function transition(input, action) {
    // Copy all caller-owned data before the first asynchronous authorization.
    const value = request(input, action);
    const namespace = await guard(value, `${action}-head`);
    async function replay(prior) {
      if (!matchesRequest(prior, value, action)) fail('head_request_conflict');
      await validateTransition(prior, namespace, value.agent, value.name);
      await verifySnapshot(namespace, value.agent, value.name, prior.manifest_id, prior.content_sha256);
      return { candidateOnly: true, replay: true, transition: prior };
    }
    async function reconcileConflict(code) {
      // Another identical caller can commit after our initial request lookup but
      // before a current-head/known-target read. Resolve that operation before
      // reporting a stale precheck; never silently rebase or create a new write.
      const committed = await priorRequest(namespace, value);
      if (committed) return replay(committed);
      fail(code);
    }
    const prior = await priorRequest(namespace, value);
    if (prior) return replay(prior);
    const current = await head(namespace, value.agent, value.name);
    if (current) await validateTransition(current, namespace, value.agent, value.name);
    if ((current?.fence ?? 0) !== value.expectedFence) return reconcileConflict('head_fence_conflict');
    if ((current?.version ?? 0) !== value.expectedVersion) return reconcileConflict('head_version_conflict');
    if (action === 'fence' && !current) fail('head_not_initialized');
    const id = action === 'fence' ? current.manifest_id : value.manifestId;
    if (action === 'advance') {
      // Known targets require the separate rollback-head permission, including
      // selecting the current target again with a different request identity.
      // Exact historical replay already returned above without a new write.
      const seen = await db.prepare(`SELECT version FROM pilot_working_memory_transitions
        WHERE namespace = ? AND agent_slug = ? AND memory_name = ? AND manifest_id = ? LIMIT 1`)
        .bind(namespace, value.agent, value.name, id).first();
      if (seen) return reconcileConflict('head_advance_target_known');
    }
    const snapshot = await verifySnapshot(namespace, value.agent, value.name, id);
    const fields = {
      namespace, agent_slug: value.agent, memory_name: value.name,
      version: value.expectedVersion + 1, expected_version: value.expectedVersion,
      fence: value.expectedFence + (action === 'fence' ? 1 : 0), expected_fence: value.expectedFence,
      action, manifest_id: id, content_sha256: snapshot.manifest.content_sha256,
      previous_manifest_id: current?.manifest_id ?? null, request_id: value.requestId,
      committed_at: now().toISOString(),
    };
    // This ONE statement plus its trigger is the transaction. D1 does not need
    // unsupported BEGIN/COMMIT calls or a non-atomic read + pointer/history pair.
    const result = await db.prepare(`INSERT INTO pilot_working_memory_transitions (
      namespace, agent_slug, memory_name, version, expected_version, fence, expected_fence,
      action, manifest_id, content_sha256, previous_manifest_id, request_id, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(...Object.values(fields)).run();
    if (result?.success === false) fail('head_write_failed');
    const saved = await priorRequest(namespace, value);
    if (!saved) fail('head_version_conflict');
    if (!matchesRequest(saved, value, action)) fail('head_request_conflict');
    await validateTransition(saved, namespace, value.agent, value.name);
    if (saved.manifest_id !== id || saved.content_sha256 !== snapshot.manifest.content_sha256) fail('head_history_integrity_failure');
    return { candidateOnly: true, replay: result?.meta?.changes === 0, transition: saved };
  }
  return Object.freeze({
    advanceHead: input => transition(input, 'advance'),
    rollbackHead: input => transition(input, 'rollback'),
    fenceHead: input => transition(input, 'fence'),
    async readCandidate(input) {
      const value = metadata(input, ['agent', 'name']); scope(value);
      const namespace = await guard(value, 'read-candidate');
      const row = await head(namespace, value.agent, value.name);
      if (!row) return null;
      await validateTransition(row, namespace, value.agent, value.name);
      const snapshot = await verifySnapshot(namespace, value.agent, value.name, row.manifest_id, row.content_sha256);
      return { candidateOnly: true, head: row, ...snapshot };
    },
  });
}
