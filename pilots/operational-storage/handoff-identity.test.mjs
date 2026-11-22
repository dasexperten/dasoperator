import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffIdentityResolver } from './handoff-identity.mjs';
const commit = '16149d51389cbc4d625bbc8e26d766890e232c14';
function fixture(platform = 'instagram', handle = 'old') {
  const binding = { agent: 'diana-helios', spreadsheetId: 'synthetic-workbook', tabId: 0, caseId: 'case-1', checkpoint: 'snapshot-1', platform, normalized_handle: handle, manualStage: '' };
  return { agent: binding.agent, config: { namespace: 'pilot-identity', agents: { 'diana-helios': 'shadow', angela: 'shadow' } }, snapshot: { binding, provenance: { reference: 'synthetic-only', checkpoint: 'snapshot-1', sourceCommit: commit, state: 'current' },
    coverage: { creators: true, profiles: true, handleHistory: true, purgeMarkers: true, doNotContact: true },
    creators: [{ id: 'actual-survivor', normalized_handle: 'current', lifecycle_stage: '' }],
    profiles: [{ id: 'actual-profile', creator_id: 'actual-survivor', platform, handle: 'Current', normalized_handle: 'current' }],
    handleHistory: [{ id: 'history-1', creator_platform_id: 'actual-profile', platform, old_handle: 'old', new_handle: 'current', evidence: 'synthetic explicit source history', changed_at: '2026-11-05T00:00:00.000Z' }], purgeMarkers: [], doNotContact: [] } };
}
function run(o) {
  const r = createHandoffIdentityResolver(o).resolve(o.snapshot.binding);
  assert.equal(r.readOnly, true); assert.equal(r.cutoverAllowed, false); assert.equal(r.creationAllowed, false);
  assert.equal(r.reinvitationAllowed, false); assert.equal(r.liveWrites, false); assert.equal(r.verification, 'UNVERIFIED'); assert.deepEqual(r.actions, []);
  return r;
}
test('actual IDs, empty stages, history and current relationship survive', () => {
  const r = run(fixture()); assert.equal(r.status, 'resolved'); assert.equal(r.match.creator_id, 'actual-survivor');
  assert.equal(r.match.creator_platform_id, 'actual-profile'); assert.equal(r.match.lifecycle_stage, ''); assert.equal(r.binding.manualStage, ''); assert.deepEqual(r.match.aliases, ['current', 'old']);
});
test('current handle resolves directly without generated identity', () => { const o = fixture('instagram', 'current'); o.snapshot.handleHistory = []; assert.equal(run(o).status, 'resolved'); });
test('explicit multistep rename chain resolves', () => { const o = fixture(); o.snapshot.handleHistory[0].new_handle = 'middle'; o.snapshot.handleHistory.push({ ...o.snapshot.handleHistory[0], id: 'history-2', old_handle: 'middle', new_handle: 'current' }); assert.equal(run(o).status, 'resolved'); });
test('absent observation never permits creation or reinvitation', () => { const o = fixture(); o.snapshot.creators = []; o.snapshot.profiles = []; o.snapshot.handleHistory = []; assert.equal(run(o).status, 'absent-observed'); });
test('orphan profile and history remain unknown', () => {
  for (const mutate of [o => o.snapshot.creators = [], o => o.snapshot.profiles = [], o => o.snapshot.handleHistory[0].creator_platform_id = 'deleted-profile', o => o.snapshot.handleHistory[0].platform = 'tiktok']) { const o = fixture(); mutate(o); assert.equal(run(o).status, 'unknown'); }
});
test('unconnected rename does not map a different handle', () => { const o = fixture(); o.snapshot.handleHistory[0].new_handle = 'unobserved'; assert.equal(run(o).reason, 'history_not_connected_to_current_profile'); });
test('conflicting current handles and history aliases are ambiguous', () => {
  for (const handle of ['old', 'current']) { const o = fixture(); o.snapshot.profiles.push({ ...o.snapshot.profiles[0], id: 'second-profile', normalized_handle: handle }); assert.equal(run(o).status, 'ambiguous'); }
});
test('duplicate IDs are ambiguous', () => { for (const name of ['profiles', 'creators', 'handleHistory']) { const o = fixture(); o.snapshot[name].push({ ...o.snapshot[name][0] }); assert.equal(run(o).status, 'ambiguous'); } });
test('purge and DNC veto both original and current alias', () => {
  for (const handle of ['old', 'current']) for (const type of ['purge', 'dnc']) {
    const o = fixture(); if (type === 'purge') o.snapshot.purgeMarkers.push({ key: `ugc_purged:instagram:${handle}`, value: '{"reason":"silent_7d","at":1}', updated_at: 1 });
    else o.snapshot.doNotContact.push({ platform: 'instagram', normalized_handle: handle, reference: 'synthetic-dnc' });
    assert.equal(run(o).status, 'blocked');
  }
});
test('purged absence is blocked', () => { const o = fixture(); o.snapshot.profiles = []; o.snapshot.creators = []; o.snapshot.handleHistory = []; o.snapshot.purgeMarkers.push({ key: 'ugc_purged:instagram:old', value: '{}', updated_at: 1 }); assert.equal(run(o).status, 'blocked'); });
test('platforms never collapse, even with the same handle', () => { const o = fixture(); o.snapshot.profiles.push({ ...o.snapshot.profiles[0], id: 'tt-profile', platform: 'tiktok' }); assert.equal(run(o).status, 'resolved'); });
test('Threads and other are explicitly unsupported', () => { for (const p of ['threads', 'other', 'Instagram', 'instagram ']) assert.equal(run(fixture(p)).reason, 'unsupported_platform_semantics'); });
test('no normalization, fuzzy matching or handle-derived ID lookup', () => { for (const h of ['@old', 'OLD', 'https://instagram.com/old', ' old']) assert.equal(run(fixture('instagram', h)).status, 'absent-observed'); });
test('all coverage and current provenance required', () => {
  for (const field of Object.keys(fixture().snapshot.coverage)) { const o = fixture(); o.snapshot.coverage[field] = false; assert.equal(run(o).status, 'unknown'); }
  for (const state of ['unknown', 'historical']) { const o = fixture(); o.snapshot.provenance.state = state; assert.equal(run(o).status, 'unknown'); }
});
test('all binding fields are exact including stage and agent', () => {
  const o = fixture(), resolver = createHandoffIdentityResolver(o);
  for (const field of Object.keys(o.snapshot.binding)) { const b = { ...o.snapshot.binding, [field]: field === 'tabId' ? 1 : field === 'agent' ? 'angela' : 'different' }; assert.equal(resolver.resolve(b).reason, 'binding_mismatch'); }
  o.snapshot.provenance.checkpoint = 'different'; assert.equal(run(o).status, 'unknown');
});
test('both agents supported with no cross-agent activation', () => { const o = fixture(); o.agent = o.snapshot.binding.agent = 'angela'; assert.equal(run(o).status, 'resolved'); o.agent = 'diana-helios'; assert.throws(() => createHandoffIdentityResolver(o), /snapshot_agent_mismatch/); });
test('constructor isolates inputs; outputs recursively immutable and isolated', () => {
  const o = fixture(), input = structuredClone(o.snapshot.binding), resolver = createHandoffIdentityResolver(o);
  o.snapshot.profiles[0].creator_id = 'changed'; o.snapshot.creators[0].lifecycle_stage = 'agreed'; o.snapshot.handleHistory[0].old_handle = 'changed';
  const r = resolver.resolve(input); assert.equal(r.status, 'resolved'); assert.equal(r.match.lifecycle_stage, '');
  assert.throws(() => r.actions.push('write'), TypeError); assert.throws(() => r.match.history[0].old_handle = 'changed', TypeError);
  input.manualStage = 'changed'; assert.equal(r.binding.manualStage, ''); assert.notEqual(resolver.resolve(r.binding).match, r.match);
});
test('inherited fields, accessors, symbols, unknown keys and sparse/custom arrays rejected without getter activation', () => {
  let called = false;
  const variants = [
    o => Object.setPrototypeOf(o, { extra: true }),
    o => { const v = o.snapshot; delete o.snapshot; Object.setPrototypeOf(o, { snapshot: v }); },
    o => Object.defineProperty(o.snapshot, 'coverage', { enumerable: true, get() { called = true; throw Error('getter'); } }),
    o => o.snapshot[Symbol('hidden')] = true,
    o => o.snapshot.extra = true,
    o => delete o.snapshot.profiles[0],
    o => o.snapshot.profiles.extra = true,
    o => Object.defineProperty(o.snapshot.profiles, '0', { enumerable: true, get() { called = true; throw Error('getter'); } }),
    o => o.snapshot.coverage.creators = 'true',
    o => Object.defineProperty(o.snapshot.binding, 'caseId', { value: 'x', enumerable: false }),
  ];
  for (const mutate of variants) { const o = fixture(); mutate(o); assert.throws(() => createHandoffIdentityResolver(o), /invalid_/); }
  assert.equal(called, false);
});
test('no callback options, writes, network adapters or implicit authority', () => { const o = fixture(); o.lookup = () => { throw Error('must not run'); }; assert.throws(() => createHandoffIdentityResolver(o), /invalid_options/); });
test('unreviewed source contract remains unknown', () => { const o = fixture(); o.snapshot.provenance.sourceCommit = 'different'; assert.equal(run(o).reason, 'unsupported_source_contract'); });
test('card without profile cannot be considered fresh absence', () => { const o = fixture(); o.snapshot.profiles = []; o.snapshot.handleHistory = []; assert.equal(run(o).reason, 'creator_without_profile'); });
test('conflicting explicit rename targets fail', () => { const o = fixture(); o.snapshot.handleHistory.push({ ...o.snapshot.handleHistory[0], id: 'history-2', new_handle: 'middle' }, { ...o.snapshot.handleHistory[0], id: 'history-3', old_handle: 'middle' }); assert.equal(run(o).reason, 'conflicting_history'); });

test('default off and other-agent shadow never read snapshot or resolve input', () => {
  const poison = new Proxy({}, { getPrototypeOf() { throw Error('snapshot read'); }, get() { throw Error('snapshot read'); } });
  for (const o of [undefined, {}, { agent: 'angela', snapshot: poison }, { agent: 'angela', config: { namespace: 'pilot-identity', agents: { 'diana-helios': 'shadow', angela: 'off' } }, snapshot: poison }]) {
    const r = createHandoffIdentityResolver(o).resolve(poison); assert.equal(r.status, 'disabled'); assert.deepEqual(r.actions, []); assert.equal(r.creationAllowed, false); assert.ok(Object.isFrozen(r));
  }
});
test('shadow needs explicit agent and valid independent snapshot', () => {
  const o = fixture(); delete o.agent; assert.throws(() => createHandoffIdentityResolver(o), /resolver_agent_required/);
  const p = fixture(); delete p.snapshot; assert.throws(() => createHandoffIdentityResolver(p), /invalid_snapshot/);
});
test('source and ERP manual stages are preserved and disagreement blocks', () => {
  for (const [source, erp] of [['', 'agreed'], ['refused', ''], ['agreed', 'refused']]) {
    const o = fixture(); o.snapshot.binding.manualStage = source; o.snapshot.creators[0].lifecycle_stage = erp;
    const r = run(o); assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'manual_stage_conflict');
    assert.equal(r.binding.manualStage, source); assert.equal(r.match.manualStage, source); assert.equal(r.match.lifecycle_stage, erp); assert.equal(r.match.manualStageConflict, true); assert.equal(r.match.manualStageReconciliation, 'not_performed');
  }
});
test('matching stages do not claim reconciliation', () => { const r = run(fixture()); assert.equal(r.match.manualStageConflict, false); assert.equal(r.match.manualStageReconciliation, 'not_performed'); });
test('all non-Instagram purge semantics fail closed, notwithstanding coverage booleans', () => {
  for (const p of ['tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube']) assert.equal(run(fixture(p)).reason, 'unsupported_purge_marker_semantics');
});
test('unsupported purge marker families reject instead of silently ignoring', () => { const o = fixture(); o.snapshot.purgeMarkers.push({ key: 'ugc_purged:tiktok:old', value: '{}', updated_at: 1 }); assert.throws(() => run(o), /invalid_purge_marker/); });
test('cycles and self-loops never establish identity', () => {
  for (const edges of [[['old', 'current'], ['current', 'old']], [['current', 'current']], [['x', 'y'], ['y', 'x']]]) {
    const o = fixture(); const template = o.snapshot.handleHistory[0];
    o.snapshot.handleHistory = edges.map(([old_handle, new_handle], i) => ({ ...template, id: `cycle-${i}`, old_handle, new_handle }));
    assert.equal(run(o).reason, 'history_cycle_unsupported');
  }
});
test('unrelated aliases conflict snapshot-wide', () => {
  const o = fixture();
  for (const id of ['unrelated-1', 'unrelated-2']) o.snapshot.profiles.push({ ...o.snapshot.profiles[0], id, normalized_handle: 'unrelated' });
  assert.equal(run(o).reason, 'conflicting_alias_mapping');
});
test('aggregate row budget accepts exact boundary and rejects one extra before cloning', () => {
  const o = fixture();
  o.snapshot.doNotContact = Array.from({ length: 9997 }, () => ({ platform: 'instagram', normalized_handle: 'excluded', reference: 'synthetic' }));
  assert.equal(run(o).status, 'resolved');
  o.snapshot.doNotContact.push({ ...o.snapshot.doNotContact[0] });
  const original = globalThis.structuredClone; let cloned = false;
  globalThis.structuredClone = (...args) => { cloned = true; return original(...args); };
  try { assert.throws(() => createHandoffIdentityResolver(o), /snapshot_row_budget_exceeded/); assert.equal(cloned, false); }
  finally { globalThis.structuredClone = original; }
});
function stringUnits(v) {
  if (typeof v === 'string') return v.length;
  if (v && typeof v === 'object') return Object.values(v).reduce((sum, child) => sum + stringUnits(child), 0);
  return 0;
}
test('aggregate text budget accepts 4 Mi code units and rejects one extra before cloning', () => {
  const o = fixture(), max = 4 * 1024 * 1024;
  const row = { platform: 'instagram', normalized_handle: 'excluded', reference: 'x'.repeat(4096) };
  while (stringUnits(o.snapshot) + stringUnits(row) <= max) o.snapshot.doNotContact.push({ ...row });
  // Keep a final reference below its per-field limit so exactly one additional unit can be tested.
  o.snapshot.doNotContact.push({ ...row, reference: 'x' });
  const final = o.snapshot.doNotContact.at(-1);
  final.reference = 'x'.repeat(max - stringUnits(o.snapshot) + 1);
  assert.equal(stringUnits(o.snapshot), max); assert.equal(run(o).status, 'resolved');
  final.reference += 'x'; assert.equal(stringUnits(o.snapshot), max + 1);
  const original = globalThis.structuredClone; let cloned = false;
  globalThis.structuredClone = (...args) => { cloned = true; return original(...args); };
  try { assert.throws(() => createHandoffIdentityResolver(o), /snapshot_text_budget_exceeded/); assert.equal(cloned, false); }
  finally { globalThis.structuredClone = original; }
});
test('maximum-row ordered history chain resolves without quadratic traversal', () => {
  const o = fixture(), n = 9998, template = o.snapshot.handleHistory[0];
  o.snapshot.binding.normalized_handle = 'h0'; o.snapshot.profiles[0].normalized_handle = `h${n}`;
  o.snapshot.handleHistory = Array.from({ length: n }, (_, i) => ({ ...template, id: `chain-${i}`, old_handle: `h${i}`, new_handle: `h${i + 1}` }));
  const start = performance.now(), r = run(o), elapsed = performance.now() - start;
  assert.equal(r.status, 'resolved'); assert.equal(r.match.history.length, n); assert.equal(r.match.aliases.length, n + 1);
  // Broad regression guard: old repeated full scans took >11 seconds for this input.
  assert.ok(elapsed < 4000, `maximum chain took ${elapsed.toFixed(0)} ms`);
});
