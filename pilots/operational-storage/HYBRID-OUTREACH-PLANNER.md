# Disabled hybrid outreach transition planner

This is a detached, local, read-only planning contract, not an active migration,
classifier, rules loader or transfer service. `hybrid-outreach-planner.mjs` has no
network, database, storage, source mutation, schema, send, publish, grant, deletion,
retry or transition API. Its only method is synchronous `plan`. Every result,
including a candidate, returns `readOnly: true`, `cutoverAllowed: false`,
`liveWrites: false`, `actions: []`, `productionVerification: 'integration_required'`
and `transitionMechanism: 'not_implemented'`.

## Current intended boundary

Preliminary comments and contact remain in the existing Google Sheet. A blogger
response alone does not move a case. Only a deliberately reviewed substantive
conversation can become a candidate for a future reviewed transition. Once that
transition is actually established, subsequent work belongs to the existing ERP
case. Planning a candidate does not establish that transition and leaves its
current destination as Google Sheets.

The current Git rule “agreed bloggers only” can be stale relative to this user
clarification. This preparation does not edit, deploy or activate that rule, a
loader, or an automatic decision process. Human-selected stages are preserved
verbatim; they are not substring-matched, normalized, advanced or interpreted as
approval. An explicit empty `manualStage: ''` is preserved: existing imported UGC
cards can have a blank lifecycle stage. A stage named “agreed” or “substantive”
is not a transfer decision. Blank does not imply “replied” or “agreed”.

The clarification does not require moving or deleting preliminary history. This
module neither copies Sheet rows nor stores contact/comment text. Original Sheet,
thread and reply links are retained as references. Source history ownership,
retention and any selected-history transfer require separate review.

## Construction contract

`createHybridOutreachPlanner({ agent, config, trustedSnapshot }).plan(binding)`

- Missing config is off and returns before inspecting the binding or snapshot.
  An enabled configuration requires an explicit own construction `agent`; it is
  never inferred from the snapshot, input, prototype or sole enabled scope.
- Config uses the existing exact `diana-helios` / `angela` `off` / `shadow` contract
  from `store.mjs`. There is no primary mode or alias scope. Either exact agent
  can plan when its own scope is shadow. Enabling the other agent does not enable
  the selected one. Nothing changes either agent's publishing decisions or rules.
- `binding` consists of an explicit own `agent`, `source`, nullable `reply`,
  and `manualStage`. The stage is a required own string field, including an
  explicitly empty string; omission, non-strings, control characters, malformed
  Unicode and values longer than 4096 characters remain invalid. Snapshot binding must match the construction agent. Source
  input and decision binding include that same exact agent in their identity; a
  cross-agent input or decision cannot reuse the reviewed checkpoint.
- `source` has `type: 'google-sheets'`, `spreadsheetId`, `tabId`, `caseId`, `threadId`,
  `checkpoint`, `handle`, `originalUrl` and `threadUrl`. `spreadsheetId` identifies
  the workbook; `tabId` is its numeric tab/gid, a nonnegative safe integer. Both
  are bound exactly, including in the qualification decision. Tab titles are not IDs.
- `caseId` must be an independently maintained stable, opaque case identity,
  never a row position or handle-derived ID. Row moves must not create new cases.
  No row-number-to-case mapper or lineage generator is supplied. The
  workbook ID, tab ID and case ID together with the exact agent identify the case
  across checkpoints; checkpoints fence review, not new-case creation. Handles are additionally pinned, never used for fuzzy
  matching. The caller must establish the stable identity before using this seam.
  The live notebook inspection did not establish stable case/person or substantive
  decision columns; this module invents no live IDs and writes no columns. Stable
  identity provisioning and its verified mapping remain production prerequisites.
  Only Instagram and instructions tabs were reported as existing. Facebook and
  Threads tab existence remains unverified/missing, not invented by this planner.
  Tests use synthetic workbook and tab IDs only.
- A non-null reply has `kind: 'blogger-response'`, `id`, `threadId`, `checkpoint`
  and `originalUrl`. Reply thread/checkpoint must match the source exactly.
  An outbound comment is not a response. These metadata assertions are not
  independently verified by this module.
- `trustedSnapshot` contains a complete `binding`, `provenance: {reference,
  checkpoint}`, `sourceState`, `doNotContact`, nullable `purgeMarker`,
  `relationship: {status, erpCaseId}`, `actionOutcome` and nullable `decision`.
- `sourceState` is `current`, `absent`, `purged`, `unknown` or `historical`.
  Relationship status is `unmapped`, `mapped`, `absent` or `ambiguous`. Only a
  reviewed, complete relationship lookup may assert `unmapped`; a missing lookup
  is `absent`, never evidence that it is safe to create a new case. A `mapped`
  relationship requires its existing opaque ERP case ID. Other states require
  a null ERP ID.
- `actionOutcome` is `settled`, `unknown`, `in_progress` or `uncertain`.
  `settled` means the reviewed snapshot has no unresolved external outcome,
  not proof of successful outreach or permission to repeat it. The original
  authoritative evidence remains elsewhere; this module invents no receipt.
- A decision has its own complete `binding`, `kind: 'substantive' | 'preliminary'`,
  `decisionId`, `reviewerId`, ISO UTC `decidedAt`, and
  `provenance: {reference, checkpoint}`. All source/thread/reply/handle/checkpoint,
  original-link and manual-stage values must match the current binding exactly.
  Changes require fresh reviewed metadata; an old decision cannot be silently
  rebound to a new reply or checkpoint.

`trustedSnapshot` is a **future, separately verified construction input**. The
word “trusted”, human-looking reviewer fields, imported `approved: true`, a
source body or a historical archive does not verify it. Unknown fields, raw
comment bodies and approval flags are rejected. The planner only validates
metadata consistency under a caller-supplied pin. There is no production source
or qualification-decision verifier, authenticated reviewer service or decision reader in
this preparation. Synthetic tests supply the pin; that is not production proof.
Do not construct the pin from the untrusted binding being evaluated.

Construction copies config and snapshot. Planning returns fresh metadata copies,
never mutates source/snapshot or consumes decisions, and is deterministic on
identical input. Replanning cannot execute or duplicate an external action.

## Result precedence

1. Off stays `disabled` without inspecting inputs.
2. Exact binding mismatch blocks. Do-not-contact, purge markers and purged source
   state block; no creator is restored from a historical decision or archive.
3. Non-current source state and absent/ambiguous relationships block.
4. Unknown, uncertain or in-progress external outcomes block, even for mapped
   ERP cases. Their outcome and mapping remain in the report; no replay is offered.
5. A current mapped case returns `already_mapped_erp`, retaining its ID and manual
   stage. Future work belongs to that ERP case; no second case is suggested.
6. No blogger reply returns `keep_in_sheets`.
7. A reply without a decision returns `substantive_review_required` in Sheets.
8. A mismatched decision blocks. A matching preliminary qualification decision returns
   `keep_in_sheets`.
9. A matching substantive decision returns `reviewed_transition_candidate` only.
   Source and qualification-decision verification and a future reviewed transition remain gates.

The decision, source references, stage, deletion indicators, relationship and
outcome metadata remain available in enabled reports. The module performs no
reconciliation of live facts and never claims an observed checkpoint is fresh.

## Relationship to existing archive contracts

`capture.mjs` archives exact existing bytes after independent source verification;
its D1 key `erp-d1/ugc_creators/<encoded opaque ID>` is not a new Sheet-to-ERP map.
This planner does not add Google Sheets to capture's allowed source types or
copy a personal-data row into archive storage. Archive-only snapshots and
approval fields are not active outreach state or human authority.

`reconciliation.mjs` compares separately pinned inventories and exact bytes and
always leaves cutover readiness false. Matching archived bytes does not establish
current creator existence, relationship completeness, human judgment or action
outcomes. Its historical/missing source results must not revive a deleted creator.
This planner preserves the same distinction and introduces no reconciliation or
transfer writes, schema application, active reader or configuration change.

Before any actual transition, a separate reviewed mechanism must establish a
fresh consistent source checkpoint, authentic qualification decision and exact identities,
complete current ERP relationships and do-not-contact/deletion markers, preserve
manual stage and external outcome/duplicate protection, and atomically establish
subsequent ERP ownership with conflict handling. No such mechanism or grant is
included here. A candidate report must never be used as a transfer authorization.

## Synthetic verification

Run from this directory using Node 24:

```sh
node --import ./no-network.mjs --test hybrid-outreach-planner.test.mjs
```

Tests cover off/default and exact scope, no reply versus reply alone versus
substantive review, preliminary decisions, repeated planning, changed source,
reply, checkpoint, handle and stage, mapping ambiguity/absence, purged or absent
creators, historical snapshots, unresolved outcomes, existing ERP identity,
provenance retention and rejection of imported approval/classifier inputs.
No real Sheet, credentials, live ERP, private-capability module or source contents
are read. No commit, remote publication, active loader or deployment is part of
this change.

## Observed existing notebook, not a live binding

A read-only connector inspection on 2026-11-05 found the existing workbook
`1i1099gbjC6-OyV-4Bve7U0GE_aQJKa3jQ5JNXxjiUeg`, Instagram tab gid 894663735,
and an instructions tab. No Facebook or Threads tabs were present. Header-only
metadata is retained in fixtures/notebook-schema-20261105.json. No contact rows
were read or changed, and this metadata does not configure a production reader.

Instagram already has response, comment/Direct status, evidence, next-step and
ERP/receipt columns. It has no explicit stable case/person ID, substantive-review
record or checkpoint field among populated headers. Existing ERP/receipt values
and their uniqueness were not inspected. The planner's stable identities are
therefore a future verified prerequisite, not a claim about current rows. Do not
invent them from row numbers, handles, missing records or response cells. Any
future schema extension must preserve current columns, formulas, validation,
links and the working workflow, with separate live-change authority.

Qualification assessment belongs to the existing authorized workflow. A reviewer
may be its authorized person or agent; this pilot adds no new requirement for
Owner approval on every case. Existing human-set stages and decisions remain
protected, and no supplied reviewer identifier authenticates authority.
