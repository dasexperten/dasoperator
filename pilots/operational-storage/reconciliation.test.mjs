import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createOperationalCapture } from './capture.mjs';
import { createPilotStore, sha256 } from './store.mjs';
import { createOperationalReconciliation } from './reconciliation.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();
const config = { namespace: 'pilot-reconciliation', agents: { angela: 'shadow', 'diana-helios': 'shadow' } };
const asOf = '2026-11-05T08:00:00.000Z', importedAt = '2026-11-05T08:05:00.000Z';
const checkpoint = 'reviewed-consistent-export-01';
const bodyBytes = b => typeof b === 'string' ? enc.encode(b) : new Uint8Array(b);
const sourceKey = r => JSON.stringify([r.agent, r.sourceType, r.sourceKey, r.sourceRevision]);
const manifestId = r => sha256(enc.encode(sourceKey(r)));
const ghHash = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const githubUrl = (commit, path) => `https://github.com/dasexperten/organizacia/blob/${commit}/${path.split('/').map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;

function fixture() {
  const sql = new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const objects = new Map(), knownSources = new Map();
  const counters = { reads: 0, writes: 0, gets: 0, puts: 0, auth: 0 };
  const db = { prepare(query) {
    const statement = sql.prepare(query);
    return { bind(...args) { return {
      first: async () => { counters.reads++; return statement.get(...args) ?? null; },
      all: async () => { counters.reads++; return { success: true, results: statement.all(...args) }; },
      run: async () => { counters.writes++; return { success: true, meta: { changes: Number(statement.run(...args).changes) } }; },
    }; } };
  } };
  const bucket = {
    async get(key) { counters.gets++; const b = objects.get(key); return b ? { size: b.length, arrayBuffer: async () => new Uint8Array(b).buffer } : null; },
    async put(key, b) { counters.puts++; objects.set(key, new Uint8Array(b)); },
  };
  const store = createPilotStore({ config, db, bucket, authorize: async () => true, now: () => new Date(importedAt) });
  const sourceVerifier = async d => knownSources.get(JSON.stringify([d.agent, d.source.type, d.source.key, d.source.revision])) === d.expectedSha256;
  const capture = createOperationalCapture({ config, store, sourceVerifier });
  const records = [], sourceRecords = [], scopes = new Map();
  async function add({ agent, sourceType, sourceKey: sk, sourceRevision, sourcePrefix, kind, contentType, originalUrl = null,
    body, archiveExpectation = 'required', captureNow = true, captureCall }) {
    const b = bodyBytes(body);
    const r = { agent, sourceType, sourceKey: sk, sourceRevision, kind, contentType, originalUrl,
      sha256: await sha256(b), contentBytes: b.length, archiveExpectation };
    r.manifestId = await manifestId(r);
    records.push(r); sourceRecords.push({ agent, sourceType, sourceKey: sk, sourceRevision, bytes: b });
    const identity = JSON.stringify([agent, sourceType, sourcePrefix]);
    const s = scopes.get(identity) ?? { agent, sourceType, sourcePrefix, revision: sourceRevision, expectedCount: 0 };
    assert.equal(s.revision, sourceRevision); s.expectedCount++; scopes.set(identity, s);
    knownSources.set(sourceKey(r), r.sha256);
    const captureIt = async () => captureCall(r, b);
    const saved = captureNow ? await captureIt() : null;
    return { record: r, bytes: b, saved, captureIt };
  }
  const addD1 = async (row, o = {}) => {
    const agent = o.agent ?? row.agent_slug ?? 'angela', table = o.table ?? 'org_task_runs';
    const prefix = `${table === 'ugc_creators' ? 'erp-d1' : 'organization-d1'}/${table}/`;
    const kind = table === 'agent_chat_messages' ? 'communication' : table === 'angela_article_queue' ? 'queue-snapshot' : 'operational-record';
    return add({ ...o, agent, sourceType: 'd1', sourceKey: `${prefix}${encodeURIComponent(String(row.id))}`, sourcePrefix: prefix,
      sourceRevision: o.revision ?? checkpoint, kind, contentType: 'application/json', body: o.body ?? `${JSON.stringify(row)}\n`,
      captureCall: (r, b) => capture.captureD1Row({ agent, table, checkpoint: r.sourceRevision, expectedSha256: r.sha256 }, b) });
  };
  const addGithub = async (body, o = {}) => {
    const agent = o.agent ?? 'angela', commit = o.commit ?? 'a'.repeat(40), path = o.path ?? `agents/${agent}/MEMORY.md`;
    const kind = o.kind ?? 'working-memory', contentType = o.contentType ?? 'text/plain; charset=utf-8';
    return add({ ...o, agent, sourceType: 'github', sourceKey: `dasexperten/organizacia:${path}`, sourcePrefix: `dasexperten/organizacia:agents/${agent}/`,
      sourceRevision: commit, kind, contentType, originalUrl: githubUrl(commit, path), body,
      captureCall: (r, b) => capture.captureGithubFile({ agent, repository: 'dasexperten/organizacia', commit, path,
        gitBlobSha1: ghHash(b), expectedSha256: r.sha256, contentType }, b) });
  };
  const addEvidence = async (body, o = {}) => {
    const agent = o.agent ?? 'diana-helios', sk = o.sourceKey ?? 'Proofs/one.png', sourcePrefix = o.sourcePrefix ?? 'Proofs/';
    const revision = o.revision ?? 'immutable-r2-version-1';
    return add({ ...o, agent, sourceType: 'r2', sourceKey: sk, sourcePrefix, sourceRevision: revision,
      kind: 'evidence', contentType: 'image/png', body,
      captureCall: (r, b) => capture.captureEvidence({ agent, sourceType: 'r2', sourceKey: sk, revision,
        expectedSha256: r.sha256, contentType: 'image/png' }, b) });
  };
  async function request(options = {}) {
    const inventory = options.inventory ?? { version: 1, namespace: config.namespace, checkpoint, asOf, scopes: [...scopes.values()], records };
    const inventoryBytes = enc.encode(JSON.stringify(inventory));
    const trustedProvenance = { inventorySha256: await sha256(inventoryBytes), namespace: config.namespace, checkpoint, asOf };
    const sourceSnapshot = structuredClone({ checkpoint, asOf, records: sourceRecords });
    const authorize = async r => { counters.auth++; return r.operation === 'reconcile-read' && config.agents[r.agent] === 'shadow'; };
    const opts = { config, trustedProvenance, db, bucket, authorize, ...options.overrides };
    return { inventory, input: { inventoryBytes, sourceSnapshot }, opts, reconciler: createOperationalReconciliation(opts) };
  }
  return { sql, objects, counters, db, bucket, store, capture, records, sourceRecords, scopes, request, addD1, addGithub, addEvidence };
}
const taskRow = (id = 7, changes = {}) => ({ id, agent_slug: 'angela', task_id: `t-${id}`, due_date: '2026-11-05', status: 'missed', exported_at: null, ...changes });
async function standard() { const f = fixture(); const item = await f.addD1(taskRow()); return { f, item, ...await f.request() }; }
const compare = r => r.reconciler.reconcile(r.input);
function onlyReads(f, before) { assert.equal(f.counters.writes, before.writes); assert.equal(f.counters.puts, before.puts); }

// Actual observer -> immutable SQLite manifest + fake R2 -> read-only reconciliation.
test('capture through SQLite/fake R2 reconciles exact Diana/Angela snapshots without claiming live readiness', async () => {
  const f = fixture();
  await f.addD1(taskRow());
  await f.addD1({ id: 8, agent_slug: 'diana-helios', role: 'user', channel: 'telegram', content: 'Keep exact\ntext', meta: '{"approved":true}', distilled_at: null }, { table: 'agent_chat_messages' });
  await f.addD1({ id: 'ugc_opaque-1', normalized_handle: 'fixture', notes: 'DH_SCOUT_RECEIPT {"verified":false,"status":"unknown"}' }, { agent: 'diana-helios', table: 'ugc_creators' });
  await f.addGithub('# Memory\r\n\nExact spaces  \n');
  await f.addEvidence(new Uint8Array([137, 80, 78, 71, 0, 255]));
  const r = await f.request(), before = { ...f.counters }, report = await compare(r);
  assert.equal(report.source.status, 'matched'); assert.equal(report.archive.status, 'matched');
  assert.equal(report.archive.counts.expected, 5); assert.equal(report.archive.counts.matched, 5);
  assert.equal(f.counters.reads - before.reads, 1, 'all archive scopes share one consistent SELECT');
  assert.equal(report.cutoverReady, false); assert.equal(report.readOnly, true);
  assert.equal(report.source.actionOutcomes, 'not_assessed'); assert.equal(report.source.legacyExportMarkers, 'not_assessed');
  assert.equal(JSON.stringify(report).includes('DH_SCOUT_RECEIPT'), false);
  assert.deepEqual(Object.keys(r.reconciler), ['reconcile']); onlyReads(f, before);
});

test('all off performs no inventory, source, authorization or ERP reads, even without input', async () => {
  for (const c of [undefined, { ...config, agents: {} }, { ...config, agents: { angela: 'off', 'diana-helios': 'off' } }]) {
    const deny = () => { throw Error('must not access anything'); };
    const r = createOperationalReconciliation({ config: c, db: new Proxy({}, { get: deny }), bucket: new Proxy({}, { get: deny }), authorize: deny });
    assert.equal((await r.reconcile()).skipped, 'pilot_disabled');
  }
});

test('one enabled scope never reads disabled-agent archive or blobs; configuration is copied', async () => {
  const f = fixture(); await f.addD1(taskRow()); await f.addGithub('Diana', { agent: 'diana-helios' });
  const c = { ...config, agents: { angela: 'shadow', 'diana-helios': 'off' } }, r = await f.request({ overrides: { config: c } });
  c.agents['diana-helios'] = 'shadow'; const before = { ...f.counters }, report = await compare(r);
  assert.equal(report.archive.counts.matched, 1); assert.equal(report.archive.counts.skipped, 1);
  assert.equal(f.counters.auth - before.auth, 1); assert.equal(f.counters.reads - before.reads, 1); assert.equal(f.counters.gets - before.gets, 1);
});

test('enabled configuration with no selected inventory scope does not claim empty parity', async () => {
  const f = fixture(); await f.addGithub('Diana', { agent: 'diana-helios' });
  const r = await f.request({ overrides: { config: { ...config, agents: { angela: 'shadow' } } } });
  assert.equal((await compare(r)).skipped, 'no_enabled_inventory_scopes');
});

test('exact agent/mode/field validation rejects permissive flags, symbols, accessors and inherited setup', async () => {
  for (const agents of [{ diana: 'shadow' }, { angela: 'primary' }, { angela: 'erp-primary' }]) {
    assert.throws(() => createOperationalReconciliation({ config: { ...config, agents } }), /invalid/);
  }
  assert.throws(() => createOperationalReconciliation({ config, approved: true }), /invalid_reconciliation_options/);
  assert.throws(() => createOperationalReconciliation({ config }), /trusted_provenance_required/);
  const c = { ...config }; Object.defineProperty(c, 'approved', { value: true });
  assert.throws(() => createOperationalReconciliation({ config: c }), /invalid_pilot_config/);
  assert.throws(() => createOperationalReconciliation({ config: { ...config, [Symbol('flag')]: true } }), /invalid_pilot_config/);
  let read = false; const d = { ...config }; Object.defineProperty(d, 'namespace', { enumerable: true, get() { read = true; return config.namespace; } });
  assert.throws(() => createOperationalReconciliation({ config: d }), /invalid_pilot_config/); assert.equal(read, false);
  assert.throws(() => createOperationalReconciliation({ config: Object.create(config) }), /invalid_pilot_config/);
});

test('independently pinned inventory cannot be replaced, approved by payload, or mutated after construction', async () => {
  const r = await standard(), before = { ...r.f.counters };
  r.opts.trustedProvenance.inventorySha256 = '0'.repeat(64);
  assert.equal((await compare(r)).archive.status, 'matched');
  const changed = JSON.parse(dec.decode(r.input.inventoryBytes)); changed.records[0].archiveExpectation = 'pending';
  r.input.inventoryBytes = enc.encode(JSON.stringify(changed));
  await assert.rejects(compare(r), /inventory_digest_mismatch/);
  onlyReads(r.f, before);
  r.input.approved = true;
  await assert.rejects(compare(r), /invalid_reconciliation_input/);
});

test('inventory duplicate IDs, missing expected records, overlaps and wrong manifest IDs fail before archive reads', async () => {
  for (const mutation of [
    i => i.records.push(structuredClone(i.records[0])),
    i => i.records.pop(),
    i => i.scopes.push(structuredClone(i.scopes[0])),
    i => { i.records[0].manifestId = '0'.repeat(64); },
    i => { i.records[0].sourceRevision = 'wrong'; },
    i => { i.records[0].sourceKey = 'organization-d1/org_task_runs/007'; },
  ]) {
    const f = fixture(); await f.addD1(taskRow()); const base = await f.request(), inventory = structuredClone(base.inventory); mutation(inventory);
    const r = await f.request({ inventory }), before = { ...f.counters };
    await assert.rejects(compare(r), /duplicate_inventory_record|inventory_count_mismatch|overlapping_inventory_scopes|inventory_manifest_id_mismatch|inventory_revision_mismatch|invalid_source_id/);
    assert.deepEqual(f.counters, before);
  }
});

test('source checkpoint/time mismatch blocks all archive reads and does not relabel existing outcomes', async () => {
  for (const field of ['checkpoint', 'asOf']) {
    const r = await standard(), before = { ...r.f.counters };
    r.input.sourceSnapshot[field] = field === 'checkpoint' ? 'different-consistent-export' : '2026-11-05T08:00:01.000Z';
    const report = await compare(r);
    assert.equal(report.source.status, 'blocked'); assert.equal(report.records[0].source.status, 'unverified');
    assert.equal(report.archive.status, 'not_checked'); assert.equal(report.records[0].archive.status, 'not_checked');
    assert.equal(report.issues[0].code, `source_${field === 'asOf' ? 'time' : 'checkpoint'}_mismatch`);
    assert.deepEqual(r.f.counters, before);
  }
});

test('missing source, changed revision, duplicates, wrong bytes and unexpected source IDs fail closed', async () => {
  for (const mutate of [
    r => { r.records = []; },
    r => { r.records[0].sourceRevision = 'later'; },
    r => { r.records.push(structuredClone(r.records[0])); },
    r => { r.records[0].bytes[0] ^= 1; },
    r => { r.records[0].sourceKey = 'organization-d1/org_task_runs/99'; },
    r => { r.records[0].agent = 'diana-helios'; },
  ]) {
    const r = await standard(), before = { ...r.f.counters }; mutate(r.input.sourceSnapshot);
    const report = await compare(r); assert.equal(report.source.status, 'blocked'); assert.equal(report.archive.status, 'not_checked');
    assert.equal(report.cutoverReady, false); assert.deepEqual(r.f.counters, before);
  }
});

test('archive pending, missing manifest, and missing blob remain separate from source success', async () => {
  const f = fixture(); await f.addD1(taskRow(1), { captureNow: false, archiveExpectation: 'pending' });
  await f.addD1(taskRow(2), { captureNow: false }); const third = await f.addD1(taskRow(3)); f.objects.delete(third.saved.manifest.object_key);
  const r = await f.request(), before = { ...f.counters }, report = await compare(r);
  assert.equal(report.source.status, 'matched'); assert.equal(report.archive.status, 'incomplete');
  assert.deepEqual(report.records.map(x => [x.source.status, x.archive.status, x.archive.code]), [
    ['matched', 'pending', 'archive_manifest_missing'], ['matched', 'missing', 'archive_manifest_missing'], ['matched', 'missing', 'archive_blob_missing'],
  ]); assert.equal(report.archive.counts.pending, 1); assert.equal(report.archive.counts.missing, 2); onlyReads(f, before);
});

test('orphan R2 upload without a manifest is not an archive receipt and is never cleaned up', async () => {
  const f = fixture(), item = await f.addD1(taskRow(), { captureNow: false, archiveExpectation: 'pending' });
  const orphanKey = `${config.namespace}/angela/sha256/${item.record.sha256}`;
  f.objects.set(orphanKey, item.bytes); const r = await f.request(), before = { ...f.counters }, report = await compare(r);
  assert.equal(report.records[0].archive.status, 'pending'); assert.equal(f.counters.gets, before.gets);
  assert.deepEqual(f.objects.get(orphanKey), item.bytes); onlyReads(f, before);
});

test('partial/corrupt blob reports conflict; thrown D1/R2/readback failures report unavailable, never retries', async () => {
  const scenarios = [
    { expected: 'archive_blob_metadata_conflict', override: f => ({ bucket: { get: async () => ({ size: 1, arrayBuffer: async () => new Uint8Array([0]).buffer }) } }) },
    { expected: 'archive_blob_hash_conflict', override: f => ({ bucket: { get: async () => ({ size: f.records[0].contentBytes, arrayBuffer: async () => new Uint8Array(f.records[0].contentBytes).buffer }) } }) },
    { expected: 'archive_inventory_unavailable', override: () => ({ db: { prepare() { throw Error('D1 unavailable SECRET'); } } }) },
    { expected: 'archive_blob_unavailable', override: () => ({ bucket: { get: async () => { throw Error('R2 unavailable SECRET'); } } }) },
    { expected: 'archive_blob_read_unavailable', override: f => ({ bucket: { get: async () => ({ size: f.records[0].contentBytes, arrayBuffer: async () => { throw Error('partial stream SECRET'); } }) } }) },
  ];
  for (const s of scenarios) {
    const f = fixture(); await f.addD1(taskRow()); const r = await f.request({ overrides: s.override(f) }), before = { ...f.counters }, report = await compare(r);
    assert.equal(report.records[0].archive.code, s.expected); assert.equal(report.archive.status, 'blocked');
    assert.equal(report.source.status, 'matched'); assert.equal(JSON.stringify(report).includes('SECRET'), false); onlyReads(f, before);
  }
});

test('authorization is independent, exact scoped and fails closed before any storage IO', async () => {
  for (const authorize of [undefined, async () => false, async () => ({ approved: true }), async () => { throw Error('auth down'); }]) {
    const f = fixture(); await f.addD1(taskRow()); const r = await f.request({ overrides: { authorize } }), before = { ...f.counters };
    const report = await compare(r); assert.equal(report.records[0].archive.status, 'unavailable'); assert.equal(report.archive.status, 'blocked');
    assert.deepEqual(f.counters, before);
  }
});

test('archive manifest metadata/ID/revision/namespace/agent/time corruption cannot pass equality', async () => {
  for (const update of [
    "content_type='text/plain'", "content_sha256='" + '0'.repeat(64) + "'", "manifest_id='" + '0'.repeat(64) + "'",
    "source_revision='different-checkpoint'", "namespace='pilot-foreign'", "agent_slug='diana-helios'", "imported_at='not-a-timestamp'",
  ]) {
    const r = await standard(); r.f.sql.exec(`DROP TRIGGER pilot_manifests_no_update; UPDATE pilot_operational_manifests SET ${update}`);
    const report = await compare(r); assert.notEqual(report.archive.status, 'matched'); assert.equal(report.cutoverReady, false);
  }
});

test('duplicate, foreign and malformed listing rows are conflicts and never trigger cross-scope blob reads', async () => {
  for (const change of [rows => [...rows, rows[0]], rows => [{ ...rows[0], agent_slug: 'diana-helios' }], rows => [{ ...rows[0], content_bytes: '10' }], rows => [{ ...rows[0], approved: true }]]) {
    const f = fixture(); await f.addD1(taskRow()); const rows = f.sql.prepare('SELECT * FROM pilot_operational_manifests').all();
    const r = await f.request({ overrides: { db: { prepare() { return { bind() { return { all: async () => ({ success: true, results: change(rows) }) }; } }; } } } });
    const before = { ...f.counters }, report = await compare(r);
    assert.equal(report.records[0].archive.status, 'conflicting'); assert.equal(report.archive.status, 'blocked'); assert.equal(f.counters.gets, before.gets);
  }
});

test('unexpected current-checkpoint archive IDs block parity even when expected count and bytes all match', async () => {
  const r = await standard();
  await r.f.addD1(taskRow(8)); // Added after independently pinned inventory.
  const report = await compare(r);
  assert.equal(report.archive.counts.expected, 1); assert.equal(report.archive.counts.matched, 1); assert.equal(report.archive.counts.unexpected, 1);
  assert.equal(report.archive.status, 'blocked'); assert.equal(report.cutoverReady, false);
});

test('historical revisions remain separate and cannot satisfy a missing expected checkpoint or resurrect a creator', async () => {
  const f = fixture(), row = { id: 'ugc_historical', normalized_handle: 'old', notes: 'old record, may have been intentionally cleaned up later' };
  const old = await f.addD1(row, { agent: 'diana-helios', table: 'ugc_creators' });
  const base = await f.request(), inventory = structuredClone(base.inventory);
  inventory.records[0].sourceRevision = 'next-reviewed-checkpoint'; inventory.records[0].manifestId = await manifestId(inventory.records[0]);
  inventory.scopes[0].revision = 'next-reviewed-checkpoint';
  const r = await f.request({ inventory }); r.input.sourceSnapshot.records[0].sourceRevision = 'next-reviewed-checkpoint';
  const report = await compare(r);
  assert.equal(report.archive.counts.historical, 1); assert.equal(report.records[0].archive.status, 'missing');
  assert.equal(report.source.status, 'matched'); assert.equal(f.sql.prepare('SELECT count(*) n FROM pilot_operational_manifests').get().n, 1);
  r.input.sourceSnapshot.records = []; const before = { ...f.counters }, absent = await compare(r);
  assert.equal(absent.records[0].source.status, 'missing'); assert.equal(absent.records[0].archive.status, 'not_checked');
  assert.deepEqual(f.counters, before); assert.deepEqual(f.objects.get(old.saved.manifest.object_key), old.bytes);
});

test('exact replays produce one manifest, stable reports, no repair writes or repeated source actions', async () => {
  const r = await standard(); const first = await compare(r);
  assert.equal((await r.item.captureIt()).replay, true);
  const before = { ...r.f.counters }; assert.deepEqual(await compare(r), first); assert.deepEqual(await compare(r), first);
  onlyReads(r.f, before); assert.equal(r.f.sql.prepare('SELECT count(*) n FROM pilot_operational_manifests').get().n, 1);
});

test('source and inventory buffers are copied before asynchronous hashing/authorization', async () => {
  const r = await standard(), operation = compare(r);
  r.input.inventoryBytes.fill(0); r.input.sourceSnapshot.records[0].bytes.fill(0);
  const report = await operation; assert.equal(report.archive.status, 'matched');
});

test('queue delivery unknown/publishing/scheduled and approvals remain opaque exact bytes', async () => {
  const f = fixture();
  const state = { initializedAt: 1720000000000, seen: ['keep'], articles: [{ id: 'a', status: 'scheduled', payload: { approval: { approved: true, by: 'editor', exact: '  x\n' } }, deliveries: { main: { status: 'unknown', postId: 'remote-7' }, en: { status: 'publishing', postId: 'remote-8' } } }], lastSlot: 'keep-slot' };
  const row = { id: 1, version: 41, data: JSON.stringify(state) }, original = ` ${JSON.stringify(row)}\r\n`;
  const item = await f.addD1(row, { table: 'angela_article_queue', body: original }); const r = await f.request(), before = { ...f.counters };
  const report = await compare(r);
  assert.equal(report.archive.status, 'matched'); assert.equal(dec.decode(f.objects.get(item.saved.manifest.object_key)), original);
  assert.deepEqual(JSON.parse(JSON.parse(dec.decode(f.objects.get(item.saved.manifest.object_key))).data), state);
  assert.equal(JSON.stringify(report).includes('approved'), false); onlyReads(f, before);
});

test('existing missed-count semantics and distilled markers remain unchanged after archive parity', async () => {
  const f = fixture();
  f.sql.exec('CREATE TABLE org_task_runs(id INTEGER PRIMARY KEY, agent_slug TEXT, status TEXT, exported_at TEXT); CREATE TABLE agent_chat_messages(id INTEGER PRIMARY KEY, distilled_at TEXT)');
  const rows = [taskRow(1), taskRow(2, { exported_at: '2026-11-04T00:00:00Z' }), taskRow(3, { status: 'done' }), taskRow(4, { exported_at: '' }), taskRow(5, { agent_slug: 'diana-helios' })];
  for (const row of rows) {
    f.sql.prepare('INSERT INTO org_task_runs VALUES(?,?,?,?)').run(row.id, row.agent_slug, row.status, row.exported_at);
    await f.addD1(row);
  }
  f.sql.prepare('INSERT INTO agent_chat_messages VALUES(?,?)').run(7, null);
  await f.addD1({ id: 7, agent_slug: 'angela', role: 'user', channel: 'telegram', content: 'same', distilled_at: null }, { table: 'agent_chat_messages' });
  const missedQuery = "SELECT agent_slug, SUM(status='missed' AND exported_at IS NULL) missed FROM org_task_runs GROUP BY agent_slug ORDER BY agent_slug";
  const before = f.sql.prepare(missedQuery).all(); assert.deepEqual(before.map(x => x.missed), [1, 1]);
  const r = await f.request(), report = await compare(r);
  assert.equal(report.archive.status, 'matched'); assert.deepEqual(f.sql.prepare(missedQuery).all(), before);
  assert.equal(f.sql.prepare('SELECT distilled_at FROM agent_chat_messages WHERE id=7').get().distilled_at, null);
  const mirrored = new DatabaseSync(':memory:'); mirrored.exec('CREATE TABLE org_task_runs(id INTEGER PRIMARY KEY, agent_slug TEXT, status TEXT, exported_at TEXT)');
  for (const record of f.records.filter(x => x.sourceKey.startsWith('organization-d1/org_task_runs/'))) {
    const raw = f.objects.get(`${config.namespace}/${record.agent}/sha256/${record.sha256}`), row = JSON.parse(dec.decode(raw));
    mirrored.prepare('INSERT INTO org_task_runs VALUES(?,?,?,?)').run(row.id, row.agent_slug, row.status, row.exported_at);
  }
  assert.deepEqual(mirrored.prepare(missedQuery).all(), before); mirrored.close();
});

test('literal percent/underscore and Unicode evidence prefixes cannot widen or miss the authorized SQL scope', async () => {
  const f = fixture(), prefix = 'Proofs/🙂%_';
  await f.addEvidence(new Uint8Array([1, 2]), { sourcePrefix: prefix, sourceKey: `${prefix}/proof.png` });
  const r = await f.request(), report = await compare(r);
  assert.equal(report.archive.status, 'matched'); assert.equal(report.archive.counts.matched, 1);
});

test('zero-record verified scope is still authorized and unexpected destination rows block zero parity', async () => {
  const f = fixture(); await f.addD1(taskRow());
  const inventory = { version: 1, namespace: config.namespace, checkpoint, asOf,
    scopes: [{ agent: 'angela', sourceType: 'd1', sourcePrefix: 'organization-d1/org_task_runs/', revision: checkpoint, expectedCount: 0 }], records: [] };
  const r = await f.request({ inventory }); r.input.sourceSnapshot.records = [];
  const report = await compare(r); assert.equal(report.archive.status, 'blocked'); assert.equal(report.archive.counts.unexpected, 1);
  assert.equal(report.archive.counts.expected, 0); assert.equal(report.cutoverReady, false);
});


test('earlier archive import time is not confused with source checkpoint time or action outcome', async () => {
  const r = await standard();
  r.f.sql.exec("DROP TRIGGER pilot_manifests_no_update; UPDATE pilot_operational_manifests SET imported_at='2026-11-01T00:00:00.000Z'");
  const report = await compare(r);
  assert.equal(report.archive.status, 'matched'); assert.equal(report.source.asOf, asOf); assert.equal(report.cutoverReady, false);
});


test('inherited omitted factory options cannot enable config, supply provenance or grant authorization', async () => {
  const r = await standard(), before = { ...r.f.counters };
  const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    Object.defineProperty(Object.prototype, 'config', { value: config, configurable: true });
    Object.defineProperty(Object.prototype, 'trustedProvenance', { value: r.opts.trustedProvenance, configurable: true });
    Object.defineProperty(Object.prototype, 'authorize', { value: async () => true, configurable: true });
    assert.equal((await createOperationalReconciliation({}).reconcile()).skipped, 'pilot_disabled');
    assert.throws(() => createOperationalReconciliation({ config }), /trusted_provenance_required/);
    const opts = { config, trustedProvenance: r.opts.trustedProvenance, db: r.f.db, bucket: r.f.bucket };
    const report = await createOperationalReconciliation(opts).reconcile(r.input);
    assert.equal(report.records[0].archive.code, 'archive_access_denied');
    assert.deepEqual(r.f.counters, before);
  } finally {
    for (const field of ['config', 'trustedProvenance', 'authorize']) {
      if (descriptors[field]) Object.defineProperty(Object.prototype, field, descriptors[field]);
      else delete Object.prototype[field];
    }
  }
});

test('source custom array prototype cannot hide unexpected identities from map or iteration', async () => {
  for (const property of ['map', Symbol.iterator]) {
    const r = await standard(), before = { ...r.f.counters }, values = r.input.sourceSnapshot.records;
    values.push({ ...values[0], sourceKey: 'organization-d1/org_task_runs/12345' });
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, property, { value: property === 'map'
      ? function (fn) { return [fn(this[0])]; }
      : function* () { yield this[0]; } });
    Object.setPrototypeOf(values, proto);
    await assert.rejects(compare(r), /invalid_source_records/); assert.deepEqual(r.f.counters, before);
  }
  const r = await standard(), sparse = new Array(1); sparse.extra = r.input.sourceSnapshot.records[0];
  r.input.sourceSnapshot.records = sparse;
  await assert.rejects(compare(r), /invalid_source_records/);
});

test('custom archive array prototype cannot suppress unexpected manifest identities', async () => {
  const f = fixture(); await f.addD1(taskRow()); const base = await f.request(); await f.addD1(taskRow(8));
  const rows = f.sql.prepare('SELECT * FROM pilot_operational_manifests').all(), proto = Object.create(Array.prototype);
  proto.map = function (fn) { return [fn(this[0])]; }; Object.setPrototypeOf(rows, proto);
  const r = { ...base, reconciler: createOperationalReconciliation({ ...base.opts,
    db: { prepare() { return { bind() { return { all: async () => ({ success: true, results: rows }) }; } }; } } }) };
  const before = { ...f.counters }, report = await compare(r);
  assert.equal(report.archive.status, 'blocked'); assert.equal(report.records[0].archive.code, 'archive_inventory_conflict');
  assert.equal(f.counters.gets, before.gets);
});

test('typed-array metadata cannot bypass intrinsic per-payload size limits', async () => {
  const r = await standard(), before = { ...r.f.counters }, oversized = new Uint8Array(32 * 1024 * 1024 + 1);
  Object.defineProperty(oversized, 'byteLength', { value: 0 });
  r.input.inventoryBytes = oversized;
  await assert.rejects(compare(r), /invalid_snapshot_bytes/); assert.deepEqual(r.f.counters, before);
  const small = await standard();
  Object.defineProperty(small.input.sourceSnapshot.records[0].bytes, 'byteLength', { value: 0 });
  assert.equal((await compare(small)).archive.status, 'matched', 'real typed-array bytes, not spoofed metadata, are compared');
});


test('accessor or inherited DB response fields never execute, throw secrets or establish success', async () => {
  for (const field of ['success', 'results']) {
    const r = await standard(), response = { success: true, results: [] }; let executed = false;
    Object.defineProperty(response, field, { enumerable: true, get() { executed = true; throw Error('BACKEND SECRET TOKEN'); } });
    const reconciler = createOperationalReconciliation({ ...r.opts, db: { prepare() { return { bind() { return { all: async () => response }; } }; } } });
    const report = await reconciler.reconcile(r.input);
    assert.equal(report.archive.status, 'blocked'); assert.equal(report.records[0].archive.code, 'archive_inventory_unavailable');
    assert.equal(executed, false); assert.equal(JSON.stringify(report).includes('SECRET'), false);
  }
  const r = await standard(), response = Object.create({ success: true, results: [] });
  const reconciler = createOperationalReconciliation({ ...r.opts, db: { prepare() { return { bind() { return { all: async () => response }; } }; } } });
  assert.equal((await reconciler.reconcile(r.input)).records[0].archive.code, 'archive_inventory_unavailable');
});

test('record-count and aggregate-source-byte resource bounds fail before archive I/O', async () => {
  const r = await standard(), before = { ...r.f.counters };
  r.input.sourceSnapshot.records = Array.from({ length: 10001 }, () => r.input.sourceSnapshot.records[0]);
  await assert.rejects(compare(r), /invalid_source_records/); assert.deepEqual(r.f.counters, before);
  const large = await standard(), template = large.input.sourceSnapshot.records[0], chunk = new Uint8Array(32 * 1024 * 1024);
  large.input.sourceSnapshot.records = [
    { ...template, bytes: chunk }, { ...template, bytes: chunk }, { ...template, bytes: new Uint8Array([0]) },
  ];
  const largeBefore = { ...large.f.counters };
  await assert.rejects(compare(large), /source_batch_too_large/); assert.deepEqual(large.f.counters, largeBefore);
});

test('oversized source bytes with shadowed byteLength are rejected before hashing or archive reads', async () => {
  const r = await standard(), before = { ...r.f.counters }, oversized = new Uint8Array(32 * 1024 * 1024 + 1);
  Object.defineProperty(oversized, 'byteLength', { get() { throw Error('must not inspect override'); } });
  r.input.sourceSnapshot.records[0].bytes = oversized;
  await assert.rejects(compare(r), /invalid_snapshot_bytes/); assert.deepEqual(r.f.counters, before);
});
