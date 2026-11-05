/** Disabled, metadata-only hybrid planning. No IO, actions, transfer or classifier. */
import { PILOT_AGENTS, pilotMode } from './store.mjs';

const fail = code => { throw new Error(code); };
function exact(value, keys, code, required = keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(k => typeof k !== 'string' || !keys.includes(k))
      || required.some(k => !Object.hasOwn(value, k))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) fail(code);
}
function text(value, code) {
  if (typeof value !== 'string' || !value || value.length > 4096 || !value.isWellFormed()
      || /[\x00-\x1f\x7f]/.test(value)) fail(code);
}
function link(value) {
  text(value, 'invalid_original_link');
  let parsed; try { parsed = new URL(value); } catch { fail('invalid_original_link'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('invalid_original_link');
}
function binding(value) {
  exact(value, ['agent', 'source', 'reply', 'manualStage'], 'invalid_binding');
  if (!PILOT_AGENTS.includes(value.agent)) fail('invalid_binding_agent');
  exact(value.source, ['type', 'spreadsheetId', 'tabId', 'caseId', 'threadId', 'checkpoint', 'handle', 'originalUrl', 'threadUrl'], 'invalid_source');
  if (value.source.type !== 'google-sheets') fail('invalid_source_type');
  if (!Number.isSafeInteger(value.source.tabId) || value.source.tabId < 0) fail('invalid_source_tab_id');
  for (const field of ['spreadsheetId', 'caseId', 'threadId', 'checkpoint', 'handle']) text(value.source[field], 'invalid_source_identity');
  link(value.source.originalUrl); link(value.source.threadUrl);
  // Empty is a real existing UGC lifecycle stage, not permission to infer one.
  if (value.manualStage !== '') text(value.manualStage, 'invalid_manual_stage');
  if (value.reply !== null) {
    exact(value.reply, ['kind', 'id', 'threadId', 'checkpoint', 'originalUrl'], 'invalid_reply');
    if (value.reply.kind !== 'blogger-response') fail('invalid_reply_kind');
    for (const field of ['id', 'threadId', 'checkpoint']) text(value.reply[field], 'invalid_reply_identity');
    link(value.reply.originalUrl);
    if (value.reply.threadId !== value.source.threadId || value.reply.checkpoint !== value.source.checkpoint) fail('reply_binding_mismatch');
  }
}
// Canonical field ordering, with no case folding or fuzzy identity matching.
function identity(value) {
  return JSON.stringify([value.agent,
    ...['type', 'spreadsheetId', 'tabId', 'caseId', 'threadId', 'checkpoint', 'handle', 'originalUrl', 'threadUrl'].map(k => value.source[k]),
    value.reply && ['kind', 'id', 'threadId', 'checkpoint', 'originalUrl'].map(k => value.reply[k]), value.manualStage,
  ]);
}
function provenance(value) {
  exact(value, ['reference', 'checkpoint'], 'invalid_provenance');
  text(value.reference, 'invalid_provenance'); text(value.checkpoint, 'invalid_provenance');
}
function snapshot(value) {
  exact(value, ['binding', 'provenance', 'sourceState', 'doNotContact', 'purgeMarker', 'relationship', 'actionOutcome', 'decision'], 'invalid_trusted_snapshot');
  binding(value.binding); provenance(value.provenance);
  if (value.provenance.checkpoint !== value.binding.source.checkpoint) fail('snapshot_checkpoint_mismatch');
  if (!['current', 'absent', 'purged', 'unknown', 'historical'].includes(value.sourceState)
      || typeof value.doNotContact !== 'boolean') fail('invalid_source_state');
  if (value.purgeMarker !== null) text(value.purgeMarker, 'invalid_purge_marker');
  exact(value.relationship, ['status', 'erpCaseId'], 'invalid_relationship');
  if (!['unmapped', 'mapped', 'absent', 'ambiguous'].includes(value.relationship.status)) fail('invalid_relationship');
  if (value.relationship.status === 'mapped') text(value.relationship.erpCaseId, 'invalid_erp_case_id');
  else if (value.relationship.erpCaseId !== null) fail('invalid_relationship');
  if (!['settled', 'unknown', 'in_progress', 'uncertain'].includes(value.actionOutcome)) fail('invalid_action_outcome');
  if (value.decision !== null) {
    exact(value.decision, ['binding', 'kind', 'decisionId', 'reviewerId', 'decidedAt', 'provenance'], 'invalid_decision');
    binding(value.decision.binding); provenance(value.decision.provenance);
    if (!['substantive', 'preliminary'].includes(value.decision.kind)) fail('invalid_decision_kind');
    for (const field of ['decisionId', 'reviewerId', 'decidedAt']) text(value.decision[field], 'invalid_decision');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.decision.decidedAt)
        || !Number.isFinite(Date.parse(value.decision.decidedAt))
        || new Date(value.decision.decidedAt).toISOString() !== value.decision.decidedAt) fail('invalid_decision_time');
  }
}
const base = () => ({ readOnly: true, cutoverAllowed: false, liveWrites: false, actions: [],
  productionVerification: 'integration_required', transitionMechanism: 'not_implemented' });

/**
 * trustedSnapshot is separately established metadata from trusted local setup,
 * NOT imported request flags, Sheet text, archive bytes or this planner's output.
 * Its actual decision/source provenance cannot be verified by this pure module.
 * No production verifier or transition executor is supplied.
 */
export function createHybridOutreachPlanner(options = {}) {
  exact(options, ['agent', 'config', 'trustedSnapshot'], 'invalid_planner_options', []);
  const config = Object.hasOwn(options, 'config') ? structuredClone(options.config) : undefined;
  const modes = Object.fromEntries(PILOT_AGENTS.map(agent => [agent, pilotMode(config, agent)]));
  const agent = Object.hasOwn(options, 'agent') ? options.agent : undefined;
  if (agent !== undefined && !PILOT_AGENTS.includes(agent)) fail('invalid_planner_agent');
  if (Object.hasOwn(options, 'agent') && agent === undefined) fail('invalid_planner_agent');
  if (agent === undefined && Object.values(modes).includes('shadow')) fail('planner_agent_required');
  const enabled = agent !== undefined && modes[agent] === 'shadow';
  let pin;
  if (enabled) {
    snapshot(options.trustedSnapshot);
    if (options.trustedSnapshot.binding.agent !== agent) fail('snapshot_agent_mismatch');
    pin = structuredClone(options.trustedSnapshot);
  }
  return Object.freeze({
    plan(input) {
      if (!enabled) return { ...base(), status: 'disabled', reason: 'pilot_disabled' };
      binding(input);
      const report = { ...base(), agent, binding: structuredClone(input), provenance: structuredClone(pin.provenance),
        manualStage: input.manualStage, relationship: structuredClone(pin.relationship),
        sourceState: pin.sourceState, doNotContact: pin.doNotContact, purgeMarker: pin.purgeMarker,
        actionOutcome: pin.actionOutcome, decision: structuredClone(pin.decision) };
      const result = (status, reason, destination = null) => ({ ...report, status, reason, destination });
      if (identity(input) !== identity(pin.binding)) return result('blocked', 'snapshot_binding_mismatch');
      if (pin.doNotContact || pin.purgeMarker !== null || pin.sourceState === 'purged') return result('blocked', 'do_not_contact_or_purged');
      if (pin.sourceState !== 'current') return result('blocked', 'current_source_not_established');
      if (['absent', 'ambiguous'].includes(pin.relationship.status)) return result('blocked', 'relationship_not_established');
      if (pin.actionOutcome !== 'settled') return result('blocked', 'external_outcome_unresolved');
      if (pin.relationship.status === 'mapped') return result('already_mapped_erp', 'preserve_existing_mapping', 'erp');
      if (input.reply === null) return result('keep_in_sheets', 'no_blogger_response', 'google-sheets');
      if (pin.decision === null) return result('substantive_review_required', 'response_is_not_substantive_approval', 'google-sheets');
      if (identity(pin.decision.binding) !== identity(input)
          || pin.decision.provenance.checkpoint !== input.source.checkpoint) return result('blocked', 'decision_binding_mismatch');
      if (pin.decision.kind === 'preliminary') return result('keep_in_sheets', 'qualification_decision_preliminary', 'google-sheets');
      return result('reviewed_transition_candidate', 'metadata_validated_future_reviewed_transition_required', 'google-sheets');
    },
  });
}
