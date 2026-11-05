/**
 * Non-production, archive-only D1/R2 pilot. No fetch, publisher, queue consumer,
 * cron, live Worker entrypoint or GitHub write path exists in this module.
 * A verified hash means the BYTES match, never that an external action happened.
 */
export const PILOT_AGENTS = Object.freeze(['diana-helios', 'angela']);
const KINDS = new Set(['working-memory', 'communication', 'report', 'evidence',
  'queue-snapshot', 'approval-snapshot', 'operational-record']);
const SOURCES = new Set(['github', 'd1', 'r2', 'local-export']);
const encoder = new TextEncoder();
const MAX_BYTES = 32 * 1024 * 1024;

function fail(code) { throw new Error(code); }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function textField(value, name, max = 1024) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`invalid_${name}`);
  return value;
}
function exactKeys(value, keys, name, required = []) {
  if (!plainObject(value) || Object.keys(value).some(k => !keys.includes(k))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))
      || required.some(k => !Object.hasOwn(value, k))) fail(`invalid_${name}`);
}
export function pilotMode(config, agent) {
  if (!PILOT_AGENTS.includes(agent)) fail('unsupported_agent');
  if (config === undefined || config === null) return 'off';
  exactKeys(config, ['namespace', 'agents'], 'pilot_config', ['namespace', 'agents']);
  if (!/^pilot-[a-z0-9][a-z0-9-]{0,47}$/.test(config.namespace || '')) fail('invalid_pilot_namespace');
  exactKeys(config.agents, PILOT_AGENTS, 'pilot_agents');
  for (const mode of Object.values(config.agents)) if (!['off', 'shadow'].includes(mode)) fail('invalid_pilot_mode');
  return Object.hasOwn(config.agents, agent) ? config.agents[agent] : 'off';
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function copyBytes(input) {
  let bytes;
  if (typeof input === 'string') bytes = encoder.encode(input);
  else if (input instanceof Uint8Array) bytes = new Uint8Array(input);
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input.slice(0));
  else fail('invalid_bytes');
  if (bytes.byteLength > MAX_BYTES) fail('payload_too_large');
  return bytes;
}
function validateDescriptor(input) {
  exactKeys(input, ['agent', 'source', 'kind', 'contentType', 'expectedSha256'], 'descriptor',
    ['agent', 'source', 'kind', 'contentType', 'expectedSha256']);
  if (!PILOT_AGENTS.includes(input.agent)) fail('unsupported_agent');
  if (!KINDS.has(input.kind)) fail('invalid_kind');
  textField(input.contentType, 'content_type', 128);
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:; ?charset=utf-8)?$/.test(input.contentType)) fail('invalid_content_type');
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256 || '')) fail('invalid_expected_sha256');
  exactKeys(input.source, ['type', 'key', 'revision', 'originalUrl'], 'source', ['type', 'key', 'revision']);
  if (!SOURCES.has(input.source.type)) fail('invalid_source_type');
  textField(input.source.key, 'source_key', 2048);
  textField(input.source.revision, 'source_revision', 256);
  if (Object.hasOwn(input.source, 'originalUrl') && input.source.originalUrl !== undefined && input.source.originalUrl !== null) {
    textField(input.source.originalUrl, 'original_url', 4096);
    let url;
    try { url = new URL(input.source.originalUrl); } catch { fail('invalid_original_url'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_original_url');
  }
  return structuredClone(input);
}
async function objectBytes(object) {
  if (!object || typeof object.arrayBuffer !== 'function') fail('object_missing');
  if (Number.isFinite(object.size) && object.size > MAX_BYTES) fail('object_too_large');
  return copyBytes(await object.arrayBuffer());
}
function manifestMatches(row, expected) {
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}

/**
 * authorize is a REQUIRED trusted adapter, bound to a previously authenticated
 * session/service identity. Never derive its result from an imported manifest,
 * approval flag or request JSON. There is deliberately no public HTTP endpoint.
 * Caller must use a separate D1 and private R2 bucket, not production aliases.
 */
export function createPilotStore({ config, db, bucket, authorize, now = () => new Date() } = {}) {
  // Freeze settings for this instance; changing a caller-owned object cannot enable it.
  const settings = config == null ? config : structuredClone(config);
  async function guard(agent, operation) {
    if (pilotMode(settings, agent) !== 'shadow') fail('pilot_disabled');
    if (typeof authorize !== 'function' || await authorize(Object.freeze({ agent, operation, namespace: settings.namespace })) !== true) fail('access_denied');
    if (!db?.prepare || !bucket?.get || !bucket?.put) fail('pilot_bindings_missing');
    return settings.namespace;
  }
  async function find(namespace, agent, id) {
    return await db.prepare(`SELECT * FROM pilot_operational_manifests
      WHERE namespace = ? AND agent_slug = ? AND manifest_id = ?`).bind(namespace, agent, id).first();
  }
  return Object.freeze({
    async importSnapshot(descriptor, input) {
      const value = validateDescriptor(descriptor);
      // Clone before the first I/O; callers cannot mutate bytes while hashing/uploading.
      const bytes = copyBytes(input);
      const namespace = await guard(value.agent, 'import');
      const hash = await sha256(bytes);
      if (hash !== value.expectedSha256) fail('source_hash_mismatch');
      const source = value.source;
      const id = await sha256(encoder.encode(JSON.stringify([value.agent, source.type, source.key, source.revision])));
      const key = `${namespace}/${value.agent}/sha256/${hash}`;
      const expected = {
        namespace, manifest_id: id, agent_slug: value.agent, source_type: source.type,
        source_key: source.key, source_revision: source.revision,
        original_url: Object.hasOwn(source, 'originalUrl') ? source.originalUrl ?? null : null,
        kind: value.kind, content_type: value.contentType, content_sha256: hash,
        content_bytes: bytes.byteLength, object_key: key, archive_only: 1, integrity_state: 'bytes-verified',
      };
      const prior = await find(namespace, value.agent, id);
      if (prior && !manifestMatches(prior, expected)) fail('source_revision_conflict');
      let object = await bucket.get(key);
      if (!object) {
        // Checksum is supplied to R2 and independently checked on readback below.
        await bucket.put(key, bytes, {
          sha256: hash,
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { sha256: hash, agent: value.agent, archiveOnly: 'true' },
        });
        object = await bucket.get(key);
      }
      const readback = await objectBytes(object);
      if (readback.byteLength !== bytes.byteLength || await sha256(readback) !== hash) fail('object_integrity_failure');
      if (prior) return { manifest: prior, replay: true };
      const importedAt = now().toISOString();
      const result = await db.prepare(`INSERT INTO pilot_operational_manifests (
        namespace, manifest_id, agent_slug, source_type, source_key, source_revision,
        original_url, kind, content_type, content_sha256, content_bytes, object_key,
        archive_only, integrity_state, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).bind(...Object.values(expected), importedAt).run();
      if (result?.success === false) fail('manifest_write_failed');
      const row = await find(namespace, value.agent, id);
      // A competing importer must agree on all immutable fields, not just the ID.
      if (!row || !manifestMatches(row, expected)) fail('source_revision_conflict');
      return { manifest: row, replay: result?.meta?.changes === 0 };
    },
    async readSnapshot(agent, id) {
      textField(id, 'manifest_id', 64);
      if (!/^[a-f0-9]{64}$/.test(id)) fail('invalid_manifest_id');
      const namespace = await guard(agent, 'read');
      const manifest = await find(namespace, agent, id);
      if (!manifest) return null;
      // Validate the destination even if a database row has been damaged.
      const sourceId = await sha256(encoder.encode(JSON.stringify([
        manifest.agent_slug, manifest.source_type, manifest.source_key, manifest.source_revision,
      ])));
      const expectedKey = `${namespace}/${agent}/sha256/${manifest.content_sha256}`;
      if (sourceId !== id || manifest.namespace !== namespace || manifest.agent_slug !== agent
          || !/^[a-f0-9]{64}$/.test(manifest.content_sha256) || manifest.object_key !== expectedKey
          || manifest.archive_only !== 1 || manifest.integrity_state !== 'bytes-verified') fail('manifest_integrity_failure');
      const bytes = await objectBytes(await bucket.get(expectedKey));
      if (bytes.byteLength !== manifest.content_bytes || await sha256(bytes) !== manifest.content_sha256) fail('object_integrity_failure');
      return { manifest, bytes };
    },
  });
}
