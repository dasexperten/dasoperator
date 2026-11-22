/** Pure metadata observer. Never a handoff, creation, reinvitation or mutation authority. */
import { PILOT_AGENTS as AGENTS, pilotMode } from './store.mjs';
const SOURCE_COMMIT = '16149d51389cbc4d625bbc8e26d766890e232c14';
const PLATFORMS = ['instagram', 'tiktok', 'vk', 'shopee', 'lazada', 'facebook', 'telegram', 'youtube'];
const MAX_ROWS = 10000, MAX_TEXT = 4 * 1024 * 1024;
const BINDING = ['agent', 'spreadsheetId', 'tabId', 'caseId', 'checkpoint', 'platform', 'normalized_handle', 'manualStage'];
const fail = code => { throw new Error(code); };
function exact(v, keys, name, required = keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail(`invalid_${name}`);
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (required.some(k => !Object.hasOwn(descriptors, k))
      || Reflect.ownKeys(descriptors).some(k => typeof k !== 'string' || !keys.includes(k)
        || !Object.hasOwn(descriptors[k], 'value') || !descriptors[k].enumerable)) fail(`invalid_${name}`);
}
function text(v, name, empty = false) {
  if (typeof v !== 'string' || (!empty && !v) || v.length > 4096 || !v.isWellFormed() || /[\x00-\x1f\x7f]/.test(v)) fail(`invalid_${name}`);
}
function array(v, name, validate, budget) {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > 10000) fail(`invalid_${name}`);
  budget.rows += v.length;
  if (budget.rows > MAX_ROWS) fail('snapshot_row_budget_exceeded');
  const d = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(d).length !== v.length + 1) fail(`invalid_${name}`);
  for (let i = 0; i < v.length; i++) {
    if (!Object.hasOwn(d, i) || !Object.hasOwn(d[i], 'value') || !d[i].enumerable) fail(`invalid_${name}`);
    validate(d[i].value);
    budget.addText(d[i].value);
  }
}
function binding(v) {
  exact(v, BINDING, 'binding');
  if (!AGENTS.includes(v.agent)) fail('invalid_agent');
  if (!Number.isSafeInteger(v.tabId) || v.tabId < 0) fail('invalid_tabId');
  for (const k of BINDING.filter(k => k !== 'tabId')) text(v[k], k, k === 'manualStage');
}
const bindingKey = v => JSON.stringify(BINDING.map(k => v[k]));
function row(v, fields, name) { exact(v, fields, name); for (const k of fields) text(v[k], `${name}_${k}`, k === 'lifecycle_stage'); }
function validateSnapshot(s) {
  exact(s, ['binding', 'provenance', 'coverage', 'creators', 'profiles', 'handleHistory', 'purgeMarkers', 'doNotContact'], 'snapshot');
  const budget = { rows: 0, text: 0, addText(v) {
    for (const value of Object.values(v)) if (typeof value === 'string') this.text += value.length;
    if (this.text > MAX_TEXT) fail('snapshot_text_budget_exceeded');
  } };
  binding(s.binding); budget.addText(s.binding);
  exact(s.provenance, ['reference', 'checkpoint', 'sourceCommit', 'state'], 'provenance');
  for (const k of ['reference', 'checkpoint', 'sourceCommit']) text(s.provenance[k], 'provenance');
  if (!['current', 'historical', 'unknown'].includes(s.provenance.state)) fail('invalid_provenance_state');
  budget.addText(s.provenance);
  exact(s.coverage, ['creators', 'profiles', 'handleHistory', 'purgeMarkers', 'doNotContact'], 'coverage');
  for (const v of Object.values(s.coverage)) if (typeof v !== 'boolean') fail('invalid_coverage');
  array(s.creators, 'creators', v => row(v, ['id', 'normalized_handle', 'lifecycle_stage'], 'creator'), budget);
  array(s.profiles, 'profiles', v => row(v, ['id', 'creator_id', 'platform', 'handle', 'normalized_handle'], 'profile'), budget);
  array(s.handleHistory, 'history', v => row(v, ['id', 'creator_platform_id', 'platform', 'old_handle', 'new_handle', 'evidence', 'changed_at'], 'history'), budget);
  array(s.purgeMarkers, 'purgeMarkers', v => {
    exact(v, ['key', 'value', 'updated_at'], 'purge_marker'); text(v.key, 'purge_key'); text(v.value, 'purge_value');
    if (!v.key.startsWith('ugc_purged:instagram:') || v.key === 'ugc_purged:instagram:' || !Number.isSafeInteger(v.updated_at) || v.updated_at < 0) fail('invalid_purge_marker');
  }, budget);
  array(s.doNotContact, 'doNotContact', v => row(v, ['platform', 'normalized_handle', 'reference'], 'do_not_contact'), budget);
}
function freeze(v) { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
const key = (platform, handle) => JSON.stringify([platform, handle]);

/** Independently supplied metadata assertions remain UNVERIFIED even on a resolved result. */
export function createHandoffIdentityResolver(options = {}) {
  exact(options, ['agent', 'config', 'snapshot'], 'options', []);
  const config = Object.hasOwn(options, 'config') ? options.config : undefined;
  const modes = Object.fromEntries(AGENTS.map(agent => [agent, pilotMode(config, agent)]));
  const agent = Object.hasOwn(options, 'agent') ? options.agent : undefined;
  if (Object.hasOwn(options, 'agent') && !AGENTS.includes(agent)) fail('invalid_agent');
  if (agent === undefined && Object.values(modes).includes('shadow')) fail('resolver_agent_required');
  const enabled = agent !== undefined && modes[agent] === 'shadow';
  let s;
  if (enabled) {
    validateSnapshot(options.snapshot);
    if (agent !== options.snapshot.binding.agent) fail('snapshot_agent_mismatch');
    s = structuredClone(options.snapshot);
  }
  return Object.freeze({ resolve(input) {
    if (!enabled) return freeze({ readOnly: true, actions: [], cutoverAllowed: false, creationAllowed: false,
      reinvitationAllowed: false, liveWrites: false, verification: 'UNVERIFIED', status: 'disabled', reason: 'pilot_disabled' });
    binding(input);
    const result = (status, reason, match = null) => freeze({
      readOnly: true, actions: [], cutoverAllowed: false, creationAllowed: false, reinvitationAllowed: false,
      liveWrites: false, verification: 'UNVERIFIED', status, reason, binding: structuredClone(input),
      provenance: structuredClone(s.provenance), coverage: structuredClone(s.coverage), match,
    });
    if (bindingKey(input) !== bindingKey(s.binding) || s.provenance.checkpoint !== input.checkpoint) return result('unknown', 'binding_mismatch');
    if (s.provenance.sourceCommit !== SOURCE_COMMIT) return result('unknown', 'unsupported_source_contract');
    if (!PLATFORMS.includes(input.platform)) return result('unknown', 'unsupported_platform_semantics');
    if (input.platform !== 'instagram') return result('unknown', 'unsupported_purge_marker_semantics');
    if (s.provenance.state !== 'current' || Object.values(s.coverage).some(v => v !== true)) return result('unknown', 'incomplete_or_noncurrent_snapshot');
    const creators = new Map(), profiles = new Map(), historyIds = new Set(), creatorProfiles = new Set();
    const graphs = new Map(), aliases = new Map();
    const addAlias = (platform, handle, id) => {
      const k = key(platform, handle);
      if (!aliases.has(k)) aliases.set(k, new Set());
      aliases.get(k).add(id);
    };
    for (const c of s.creators) { if (creators.has(c.id)) return result('ambiguous', 'duplicate_creator_id'); creators.set(c.id, c); }
    for (const p of s.profiles) {
      if (profiles.has(p.id)) return result('ambiguous', 'duplicate_profile_id');
      if (!creators.has(p.creator_id)) return result('unknown', 'orphan_profile');
      profiles.set(p.id, p); creatorProfiles.add(p.creator_id);
      graphs.set(p.id, { history: [], nodes: new Set([p.normalized_handle]), targets: new Map(), reverse: new Map(), indegree: new Map() });
      addAlias(p.platform, p.normalized_handle, p.id);
    }
    if (s.creators.some(c => !creatorProfiles.has(c.id))) return result('unknown', 'creator_without_profile');
    for (const h of s.handleHistory) {
      if (historyIds.has(h.id)) return result('ambiguous', 'duplicate_history_id'); historyIds.add(h.id);
      const p = profiles.get(h.creator_platform_id);
      if (!p || h.platform !== p.platform) return result('unknown', 'orphan_or_cross_platform_history');
      const g = graphs.get(p.id);
      g.history.push(h); g.nodes.add(h.old_handle); g.nodes.add(h.new_handle);
      if (g.targets.has(h.old_handle) && g.targets.get(h.old_handle) !== h.new_handle) return result('ambiguous', 'conflicting_history');
      if (!g.targets.has(h.old_handle)) {
        g.targets.set(h.old_handle, h.new_handle);
        if (!g.reverse.has(h.new_handle)) g.reverse.set(h.new_handle, []);
        g.reverse.get(h.new_handle).push(h.old_handle);
        g.indegree.set(h.new_handle, (g.indegree.get(h.new_handle) || 0) + 1);
      }
      addAlias(h.platform, h.old_handle, p.id); addAlias(h.platform, h.new_handle, p.id);
    }
    // Snapshot-wide integrity, including conflicts unrelated to the requested handle.
    if ([...aliases.values()].some(ids => ids.size > 1)) return result('ambiguous', 'conflicting_alias_mapping');
    for (const p of s.profiles) {
      const g = graphs.get(p.id);
      // Linear, iterative topological traversal rejects temporal handle reuse and self-loops.
      const queue = [...g.nodes].filter(handle => !g.indegree.has(handle));
      for (let i = 0; i < queue.length; i++) {
        if (!g.targets.has(queue[i])) continue;
        const next = g.targets.get(queue[i]), left = g.indegree.get(next) - 1;
        g.indegree.set(next, left); if (left === 0) queue.push(next);
      }
      if (queue.length !== g.nodes.size) return result('unknown', 'history_cycle_unsupported');
      const reachable = new Set([p.normalized_handle]), pending = [p.normalized_handle];
      for (let i = 0; i < pending.length; i++) for (const old of g.reverse.get(pending[i]) || []) {
        if (!reachable.has(old)) { reachable.add(old); pending.push(old); }
      }
      if (reachable.size !== g.nodes.size) return result('unknown', 'history_not_connected_to_current_profile');
    }
    const requested = key(input.platform, input.normalized_handle);
    const candidates = aliases.get(requested) || new Set();
    // Evaluate markers on the entire explicit alias family of every candidate, even if ambiguous.
    const relevant = new Set([requested]);
    for (const [k, ids] of aliases) if ([...ids].some(id => candidates.has(id))) relevant.add(k);
    if (s.purgeMarkers.some(m => relevant.has(key('instagram', m.key.slice('ugc_purged:instagram:'.length))))
        || s.doNotContact.some(m => relevant.has(key(m.platform, m.normalized_handle)))) return result('blocked', 'purge_or_do_not_contact_marker');
    if (candidates.size === 0) return result('absent-observed', 'no_existing_profile_in_asserted_snapshot');
    const p = profiles.get([...candidates][0]), c = creators.get(p.creator_id);
    const stageConflict = input.manualStage !== c.lifecycle_stage;
    return result(stageConflict ? 'blocked' : 'resolved', stageConflict ? 'manual_stage_conflict' : 'existing_identity_observed_only', {
      creator_id: c.id, creator_platform_id: p.id, platform: p.platform,
      normalized_handle: p.normalized_handle, handle: p.handle, lifecycle_stage: c.lifecycle_stage,
      manualStage: input.manualStage, manualStageConflict: stageConflict, manualStageReconciliation: 'not_performed',
      aliases: [...relevant].map(k => JSON.parse(k)[1]).sort(),
      history: structuredClone(graphs.get(p.id).history),
    });
  } });
}
