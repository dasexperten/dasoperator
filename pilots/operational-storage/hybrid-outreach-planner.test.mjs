import test from 'node:test';
import assert from 'node:assert/strict';
import { createHybridOutreachPlanner } from './hybrid-outreach-planner.mjs';

const config = { namespace: 'pilot-hybrid', agents: { 'diana-helios': 'shadow', angela: 'off' } };
function fixture({ reply = true, decision = 'substantive' } = {}) {
  const input = {
    agent: 'diana-helios',
    source: { type: 'google-sheets', spreadsheetId: 'synthetic-spreadsheet', tabId: 42, caseId: 'case-001', threadId: 'thread-1',
      checkpoint: 'snapshot-1', handle: 'synthetic_creator', originalUrl: 'https://example.test/sheet#row-1',
      threadUrl: 'https://example.test/thread/1' },
    reply: reply ? { kind: 'blogger-response', id: 'reply-1', threadId: 'thread-1', checkpoint: 'snapshot-1',
      originalUrl: 'https://example.test/thread/1/reply/1' } : null,
    manualStage: 'human-selected-stage-do-not-normalize',
  };
  const trustedSnapshot = { binding: structuredClone(input), provenance: { reference: 'synthetic-source-review', checkpoint: 'snapshot-1' },
    sourceState: 'current', doNotContact: false, purgeMarker: null, relationship: { status: 'unmapped', erpCaseId: null },
    actionOutcome: 'settled', decision: decision ? { binding: structuredClone(input), kind: decision,
      decisionId: 'decision-1', reviewerId: 'synthetic-reviewer', decidedAt: '2026-11-05T00:00:00.000Z',
      provenance: { reference: 'synthetic-human-review', checkpoint: 'snapshot-1' } } : null };
  return { input, trustedSnapshot };
}
const plan = f => createHybridOutreachPlanner({ agent: 'diana-helios', config, trustedSnapshot: f.trustedSnapshot }).plan(f.input);
function inert(result) {
  assert.equal(result.cutoverAllowed, false); assert.equal(result.liveWrites, false);
  assert.equal(result.readOnly, true); assert.deepEqual(result.actions, []);
  assert.equal(result.productionVerification, 'integration_required');
  assert.equal(result.transitionMechanism, 'not_implemented');
}

test('off by default, no input or trusted snapshot inspection and no execution API', () => {
  const planner = createHybridOutreachPlanner();
  assert.deepEqual(Object.keys(planner), ['plan']);
  const result = planner.plan(new Proxy({}, { get() { throw Error('read'); }, ownKeys() { throw Error('read'); } }));
  assert.equal(result.status, 'disabled'); inert(result);
  assert.equal(createHybridOutreachPlanner({ agent: 'diana-helios', config: { ...config, agents: { angela: 'shadow' } } }).plan(null).status, 'disabled');
});
test('no response keeps preliminary work in Sheets even with a substantive metadata decision', () => {
  const result = plan(fixture({ reply: false }));
  assert.equal(result.status, 'keep_in_sheets'); assert.equal(result.reason, 'no_blogger_response'); inert(result);
});
test('response alone needs deliberate substantive assessment', () => {
  const result = plan(fixture({ decision: null }));
  assert.equal(result.status, 'substantive_review_required'); assert.equal(result.destination, 'google-sheets'); inert(result);
});
test('human preliminary decision stays in Sheets', () => {
  assert.equal(plan(fixture({ decision: 'preliminary' })).status, 'keep_in_sheets');
});
test('substantive decision yields only a candidate, preserves manual stage, links and provenance', () => {
  const f = fixture(), result = plan(f);
  assert.equal(result.status, 'reviewed_transition_candidate'); assert.equal(result.destination, 'google-sheets');
  assert.deepEqual(result.binding, f.input); assert.deepEqual(result.decision, f.trustedSnapshot.decision);
  assert.equal(result.manualStage, f.input.manualStage); inert(result);
});
test('repeated planning is identical and cannot consume a decision or duplicate an action', () => {
  const f = fixture(), before = structuredClone(f), planner = createHybridOutreachPlanner({ agent: 'diana-helios', config, trustedSnapshot: f.trustedSnapshot });
  const a = planner.plan(f.input); assert.deepEqual(planner.plan(f.input), a); assert.deepEqual(f, before);
  a.decision.kind = 'preliminary'; a.binding.source.handle = 'mutated';
  assert.equal(planner.plan(f.input).status, 'reviewed_transition_candidate');
});
test('trusted pin and config are copied at construction', () => {
  const f = fixture(), localConfig = structuredClone(config);
  const planner = createHybridOutreachPlanner({ agent: 'diana-helios', config: localConfig, trustedSnapshot: f.trustedSnapshot });
  f.trustedSnapshot.doNotContact = true; localConfig.agents['diana-helios'] = 'off';
  assert.equal(planner.plan(f.input).status, 'reviewed_transition_candidate');
});
for (const field of ['spreadsheetId', 'caseId', 'threadId', 'checkpoint', 'handle', 'originalUrl', 'threadUrl']) {
  test(`changed exact source ${field} blocks reuse`, () => {
    const f = fixture(); f.input.source[field] += '-changed';
    if (['checkpoint', 'threadId'].includes(field)) f.input.reply[field] = f.input.source[field];
    assert.equal(plan(f).reason, 'snapshot_binding_mismatch');
  });
}
test('changed reply or manual stage blocks reuse', () => {
  for (const change of [f => { f.input.reply.id += '-new'; }, f => { f.input.manualStage = 'agreed'; }]) {
    const f = fixture(); change(f); assert.equal(plan(f).reason, 'snapshot_binding_mismatch');
  }
});
test('decision must independently match exact case/checkpoint/reply/handle and provenance', () => {
  for (const change of [d => { d.binding.source.caseId = 'case-2'; }, d => { d.binding.source.handle = 'another'; },
    d => { d.binding.reply.id = 'reply-2'; }, d => { d.provenance.checkpoint = 'old'; },
    d => { d.binding.source.checkpoint = 'old'; d.binding.reply.checkpoint = 'old'; }]) {
    const f = fixture(); change(f.trustedSnapshot.decision); assert.equal(plan(f).reason, 'decision_binding_mismatch');
  }
});
for (const state of ['purged', 'absent', 'unknown', 'historical']) {
  test(`${state} creator cannot be restored from a review/archive`, () => {
    const f = fixture(); f.trustedSnapshot.sourceState = state;
    const result = plan(f); assert.equal(result.status, 'blocked'); inert(result);
  });
}
test('do-not-contact and purge markers override even an existing ERP mapping', () => {
  for (const marker of ['doNotContact', 'purgeMarker']) {
    const f = fixture(); f.trustedSnapshot.relationship = { status: 'mapped', erpCaseId: 'erp-existing' };
    f.trustedSnapshot[marker] = marker === 'doNotContact' ? true : 'synthetic-purge-marker';
    const result = plan(f); assert.equal(result.reason, 'do_not_contact_or_purged');
    assert.deepEqual(result.relationship, f.trustedSnapshot.relationship); assert.equal(result[marker], f.trustedSnapshot[marker]);
  }
});
for (const status of ['absent', 'ambiguous']) {
  test(`${status} relationship is not permission to create another ERP case`, () => {
    const f = fixture(); f.trustedSnapshot.relationship.status = status;
    assert.equal(plan(f).reason, 'relationship_not_established');
  });
}
for (const outcome of ['unknown', 'uncertain', 'in_progress']) {
  test(`${outcome} external outcome blocks even mapped work without retry`, () => {
    const f = fixture(); f.trustedSnapshot.actionOutcome = outcome;
    f.trustedSnapshot.relationship = { status: 'mapped', erpCaseId: 'erp-existing' };
    const result = plan(f); assert.equal(result.reason, 'external_outcome_unresolved'); assert.equal(result.actionOutcome, outcome); inert(result);
  });
}
test('mapped case preserves ERP identity/stage without reimport or falling back to Sheets', () => {
  const f = fixture({ reply: false, decision: null }); f.trustedSnapshot.relationship = { status: 'mapped', erpCaseId: 'opaque:erp-01' };
  const result = plan(f); assert.equal(result.status, 'already_mapped_erp'); assert.equal(result.destination, 'erp');
  assert.equal(result.relationship.erpCaseId, 'opaque:erp-01'); assert.equal(result.manualStage, f.input.manualStage); inert(result);
});
test('approval flags, comments, payloads and classifier-style strings are not accepted', () => {
  for (const field of ['approved', 'comments', 'rows', 'archive']) {
    const f = fixture({ decision: null }); f.input[field] = field === 'approved' ? true : 'yes agreed substantive';
    assert.throws(() => plan(f), /invalid_binding/);
  }
  const f = fixture({ decision: null }); f.input.manualStage = 'approved substantive agreed'; f.trustedSnapshot.binding = structuredClone(f.input);
  assert.equal(plan(f).status, 'substantive_review_required');
  f.trustedSnapshot.decision = { approved: true }; assert.throws(() => plan(f), /invalid_decision/);
});
test('no outbound comment can masquerade as a blogger response', () => {
  const f = fixture(); f.input.reply.kind = 'outbound-comment'; assert.throws(() => plan(f), /invalid_reply_kind/);
});
test('no automatic primary mode or missing trusted metadata is accepted', () => {
  assert.throws(() => createHybridOutreachPlanner({ agent: 'diana-helios', config: { ...config, agents: { 'diana-helios': 'primary' } } }), /invalid_pilot_mode/);
  assert.throws(() => createHybridOutreachPlanner({ agent: 'diana-helios', config }), /invalid_trusted_snapshot/);
});
test('malformed/inherited/accessor decision metadata is rejected without invoking getters', () => {
  const f = fixture(); Object.defineProperty(f.trustedSnapshot.decision, 'kind', { get() { throw Error('invoked getter'); }, enumerable: true });
  assert.throws(() => plan(f), /invalid_decision/);
});
test('agent aliases and unsupported config keys cannot activate outreach planning', () => {
  for (const agents of [{ diana: 'shadow' }, { 'diana-helios': 'shadow', other: 'off' }]) {
    assert.throws(() => createHybridOutreachPlanner({ agent: 'diana-helios', config: { ...config, agents } }), /invalid_pilot_agents/);
  }
});
test('unmapped must be explicit and complete; no ERP identifier can be silently dropped', () => {
  const f = fixture(); f.trustedSnapshot.relationship = { status: 'unmapped', erpCaseId: 'existing-case' };
  assert.throws(() => plan(f), /invalid_relationship/);
  delete f.trustedSnapshot.relationship.erpCaseId;
  assert.throws(() => plan(f), /invalid_relationship/);
});
test('source and review provenance cannot be missing or fabricated by an approval flag', () => {
  const f = fixture(); f.trustedSnapshot.provenance.checkpoint = 'different';
  assert.throws(() => plan(f), /snapshot_checkpoint_mismatch/);
  const g = fixture(); delete g.trustedSnapshot.decision.reviewerId;
  assert.throws(() => plan(g), /invalid_decision/);
  const h = fixture(); h.trustedSnapshot.decision.decidedAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => plan(h), /invalid_decision_time/);
});
test('Angela-only shadow configuration can plan its explicitly scoped case', () => {
  const f = fixture(); f.input.agent = 'angela'; f.trustedSnapshot.binding.agent = 'angela';
  f.trustedSnapshot.decision.binding.agent = 'angela';
  const planner = createHybridOutreachPlanner({ agent: 'angela', config: { ...config, agents: { angela: 'shadow', 'diana-helios': 'off' } },
    trustedSnapshot: f.trustedSnapshot });
  const result = planner.plan(f.input); assert.equal(result.status, 'reviewed_transition_candidate'); assert.equal(result.agent, 'angela'); inert(result);
});
test('selected off agent stays off even if the other agent is enabled', () => {
  assert.equal(createHybridOutreachPlanner({ agent: 'angela', config }).plan(null).status, 'disabled');
});
test('cross-agent source input and decision cannot reuse a trusted case', () => {
  const f = fixture(); f.input.agent = 'angela'; assert.equal(plan(f).reason, 'snapshot_binding_mismatch');
  const g = fixture(); g.trustedSnapshot.decision.binding.agent = 'angela'; assert.equal(plan(g).reason, 'decision_binding_mismatch');
});
test('cross-agent trusted snapshot fails construction', () => {
  const f = fixture(); f.trustedSnapshot.binding.agent = 'angela'; assert.throws(() => plan(f), /snapshot_agent_mismatch/);
});
test('enabled planning requires an explicit own exact construction agent', () => {
  const f = fixture(); assert.throws(() => createHybridOutreachPlanner({ config, trustedSnapshot: f.trustedSnapshot }), /planner_agent_required/);
  for (const agent of [undefined, null, '', 'diana', 'ANGELA', 'other']) {
    assert.throws(() => createHybridOutreachPlanner({ agent, config, trustedSnapshot: f.trustedSnapshot }), /invalid_planner_agent/);
  }
  assert.throws(() => createHybridOutreachPlanner(Object.assign(Object.create({ agent: 'diana-helios' }), { config })), /invalid_planner_options/);
});
test('binding and decision require an explicit own exact agent', () => {
  for (const scope of ['input', 'snapshot', 'decision']) {
    for (const variant of ['omitted', 'invalid', 'inherited']) {
      const f = fixture(); const target = scope === 'input' ? f.input : scope === 'snapshot' ? f.trustedSnapshot.binding : f.trustedSnapshot.decision.binding;
      if (variant === 'invalid') target.agent = 'diana';
      else { delete target.agent; if (variant === 'inherited') Object.setPrototypeOf(target, { agent: 'diana-helios' }); }
      assert.throws(() => plan(f), /invalid_binding/);
    }
  }
});
test('cross-tab input or decision cannot reuse a case even within one workbook', () => {
  const f = fixture(); f.input.source.tabId = 43; assert.equal(plan(f).reason, 'snapshot_binding_mismatch');
  const g = fixture(); g.trustedSnapshot.decision.binding.source.tabId = 43; assert.equal(plan(g).reason, 'decision_binding_mismatch');
});
test('cross-workbook decision cannot reuse a tab/case identity', () => {
  const f = fixture(); f.trustedSnapshot.decision.binding.source.spreadsheetId = 'different-synthetic-workbook';
  assert.equal(plan(f).reason, 'decision_binding_mismatch');
});
test('tab IDs must be explicit nonnegative safe integers, including zero', () => {
  for (const tabId of [undefined, null, '42', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.input.source.tabId = tabId; assert.throws(() => plan(f), /invalid_source_tab_id/);
  }
  const g = fixture(); delete g.input.source.tabId; assert.throws(() => plan(g), /invalid_source/);
  const h = fixture(); h.input.source.tabId = 0; h.trustedSnapshot.binding.source.tabId = 0;
  h.trustedSnapshot.decision.binding.source.tabId = 0;
  assert.equal(plan(h).status, 'reviewed_transition_candidate');
});
test('explicit blank manual stage survives a substantive candidate without inference', () => {
  const f = fixture(); f.input.manualStage = ''; f.trustedSnapshot.binding.manualStage = '';
  f.trustedSnapshot.decision.binding.manualStage = '';
  const result = plan(f); assert.equal(result.status, 'reviewed_transition_candidate');
  assert.equal(result.manualStage, ''); assert.equal(result.binding.manualStage, '');
  assert.equal(result.decision.binding.manualStage, ''); inert(result);
});
test('explicit blank manual stage survives an existing ERP mapping without inference', () => {
  const f = fixture({ reply: false, decision: null }); f.input.manualStage = ''; f.trustedSnapshot.binding.manualStage = '';
  f.trustedSnapshot.relationship = { status: 'mapped', erpCaseId: 'synthetic-existing-blank-stage' };
  const result = plan(f); assert.equal(result.status, 'already_mapped_erp');
  assert.equal(result.manualStage, ''); assert.equal(result.binding.manualStage, ''); inert(result);
});
test('changed stage cannot reuse a stale decision, including transitions to or from blank', () => {
  for (const [current, reviewed] of [['', 'agreed'], ['replied', '']]) {
    const f = fixture(); f.input.manualStage = current; f.trustedSnapshot.binding.manualStage = current;
    f.trustedSnapshot.decision.binding.manualStage = reviewed;
    const result = plan(f); assert.equal(result.reason, 'decision_binding_mismatch');
    assert.equal(result.manualStage, current); assert.equal(result.decision.binding.manualStage, reviewed); inert(result);
  }
});
test('blank stage exception does not permit missing, inherited, malformed or non-string stages', () => {
  for (const stage of [undefined, null, false, 0, [], {}, 'x'.repeat(4097), '\u0000', '\n', '\u007f', '\ud800']) {
    const f = fixture(); f.input.manualStage = stage; assert.throws(() => plan(f), /invalid_manual_stage/);
  }
  const f = fixture(); delete f.input.manualStage; assert.throws(() => plan(f), /invalid_binding/);
  Object.setPrototypeOf(f.input, { manualStage: '' }); assert.throws(() => plan(f), /invalid_binding/);
});
