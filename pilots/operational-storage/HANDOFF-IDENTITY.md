# Read-only handoff identity observation

This local pure module resolves actual existing creator/profile IDs from independently supplied snapshot metadata. It is not a production identity verifier or a handoff endpoint. Every result is **UNVERIFIED**. It does not grant creation, reinvitation, cutover or mutation authority, even when an identity is resolved. Its only import is the existing local store module for PILOT_AGENTS and pilotMode. It has no network, database callbacks, hashing, credential handling, auth design, writes, execution adapter or deployment wiring.

The migration boundary remains unchanged: preliminary contact belongs in Sheets; a response **and deliberate substantive discussion** are necessary before ERP ownership. Identity observation does not establish either condition. No lifecycle stage is inferred, changed, manufactured or used as qualification. Empty manual stage and empty ERP lifecycle stage remain separate exact empty values.

## API and exact local contract

`createHandoffIdentityResolver({agent, config, snapshot}).resolve(binding)` returns a deeply frozen isolated report. Construction clones validated metadata; later caller mutations cannot affect resolution. Invalid shapes throw. Metadata conflicts return fail-closed observations. The existing per-agent off/shadow convention applies: default off; only the selected agent in shadow enables observation. Config is `{namespace: "pilot-identity", agents: {"diana-helios": "shadow", "angela": "off"}}`, using existing pilotMode validation. Any shadow mode requires an explicit agent. Disabled resolvers do not read or validate snapshot contents or resolve input. Other-agent shadow does not enable this agent. The optional exact options are agent, config and snapshot; enabled mode requires a valid snapshot. It accepts only `diana-helios` and `angela` and pins one agent, workbook, tab, case and checkpoint.

All objects must be ordinary exact-key own-data objects. Accessors, symbols, inherited fields, non-enumerable fields, extra keys, sparse/custom arrays and callbacks are rejected. The entire snapshot is capped at **10,000 total rows** across creators, profiles, history, purge markers and DNC assertions, and **4 Mi (4,194,304) UTF-16 code units** summed across all snapshot string values, including binding/provenance. Each string is capped at 4,096 code units, well-formed and control-free. Budgets are checked during validation, before cloning; excess is rejected with snapshot_row_budget_exceeded or snapshot_text_budget_exceeded, never truncated. These budgets limit accepted input, not allocations a caller already made before invoking the module. Inputs must be plain data, not hostile JavaScript Proxies (JavaScript cannot inspect a Proxy without running its traps); the module is not a JavaScript sandbox.

Required binding fields:
- `agent`, `spreadsheetId`, nonnegative integer `tabId`, `caseId`, `checkpoint`
- exact `platform`, exact source-canonical `normalized_handle`, and `manualStage` (empty is valid)

Snapshot fields, all required:
- `binding`: exact binding above. Every resolve input must match every field.
- `provenance`: `{reference, checkpoint, sourceCommit, state}`. Checkpoint must match; state must be `current` for a resolved/absent observation (`historical` and `unknown` block). `sourceCommit` must equal the reviewed commit below. Reference is source evidence supplied independently, not this module's output.
- `coverage`: `{creators, profiles, handleHistory, purgeMarkers, doNotContact}`, all booleans. Every field must be true before resolution. True means the supplier asserts a coherent current, complete snapshot for this binding's identity/alias search scope, including all possible competing profiles, relevant relationships, history and exclusions. A filtered result that omitted conflicts or aliases cannot honestly assert complete coverage.
- `creators`: projected `ugc_creators` rows `{id, normalized_handle, lifecycle_stage}`.
- `profiles`: projected `ugc_creator_platforms` rows `{id, creator_id, platform, handle, normalized_handle}`.
- `handleHistory`: projected `ugc_handle_history` rows `{id, creator_platform_id, platform, old_handle, new_handle, evidence, changed_at}`.
- `purgeMarkers`: projected `crm_sync_state` rows `{key, value, updated_at}`. Key is `ugc_purged:instagram:<handle>`; value is the original string; updated_at is a nonnegative safe integer. Marker presence blocks regardless of its serialized value. Other marker formats require a separately reviewed contract, not silent reinterpretation.
- `doNotContact`: local exclusion assertions `{platform, normalized_handle, reference}`. These are explicitly **not** claimed ERP table fields. Presence means excluded. Independent integration must establish their provenance and complete coverage.

Coverage, currentness, source version, canonical handles and provenance are assertions only: arbitrary caller flags cannot prove source authenticity, completeness, consistency or freshness. No supplied assertion changes the `UNVERIFIED` label. A future independently reviewed integration must establish these properties and revalidate at action time; this module cannot protect against later ERP edits or TOCTOU races. Never feed Sheet text or this result back as trusted source metadata.

## Resolution rules

- The pinned generic importer recognizes instagram, tiktok, vk, shopee, lazada, facebook, telegram and youtube, but the audited purge marker family covers **Instagram only**. Therefore this resolver conservatively returns `unknown / unsupported_purge_marker_semantics` for every non-Instagram platform recognized by the importer, even when all coverage flags are true. It cannot claim complete exclusion coverage from Instagram-only markers. `threads`, `other` and any aliases/casing variants return unknown unsupported platform semantics. Threads is never coerced to other. Unsupported marker families are rejected, never silently ignored. Supporting another platform requires a separately reviewed explicit snapshot/exclusion contract and code change.
- Handles are matched exactly as supplied, without URL parsing, trimming, lowercasing, @ stripping, fuzzy matching or ID derivation. Upstream canonicalization must be separately justified. A display `handle` is preserved but never treated as an alias without explicit normalized/history evidence.
- Current profile mappings retain their real `id` and `creator_id`. Creator normalized_handle is not a profile/platform identity key. Same handle on different platforms stays separate; profiles may share a creator only through their explicit current creator_id.
- A historical alias maps only through explicit history referencing an existing same-platform profile and an existing creator. Every history edge must connect through explicit same-profile edges to its current normalized handle. No deleted-profile redirects or guessed merge destinations.
- Duplicate IDs, conflicting alias ownership anywhere in the snapshot (even unrelated to the requested handle), and conflicting rename targets fail. Every directed history cycle, including a self-loop or an apparent return to an old handle, returns unknown/history_cycle_unsupported: temporal reuse semantics are not implemented. Graphs are indexed by profile once per resolution; creator membership is indexed, history cycle detection and reverse reachability use iterative linear traversals, not repeated scans or recursion. Alias output ordering uses a final sort. Orphan profiles/history, creators with no profiles, disconnected history and incomplete/noncurrent snapshots remain unknown. Conservative integrity checks cover the supplied snapshot, even if the bad row appears unrelated.
- Any purge or DNC marker on the requested handle or the matched profile's explicit aliases vetoes resolution. Marker-free is not contact permission.
- Source `binding.manualStage` and observed ERP `lifecycle_stage` are preserved separately. Any inequality, including empty versus nonempty, returns `blocked / manual_stage_conflict` with both values and `manualStageConflict: true` in the observed match. No value is chosen or rewritten. Equal strings merely set the conflict flag false; `manualStageReconciliation` remains `not_performed`. This is not review of ERP manual-stage records or their versions.
- `resolved` means an existing relationship was observed in asserted metadata only, never qualified discussion, fresh source authenticity, safe reinvitation or reconciled manual decisions. `absent-observed` means no profile was found in an asserted complete snapshot, not that a person is new or creation is safe. `unknown`, `ambiguous` and `blocked` always require separate investigation. No result authorizes resurrection, merging, transfer, stage changes or a fresh invitation.

Every report contains `readOnly: true`, `actions: []`, `cutoverAllowed: false`, `creationAllowed: false`, `reinvitationAllowed: false`, `liveWrites: false`, and `verification: 'UNVERIFIED'`. Resolved matches preserve source IDs, current profile handle/platform, lifecycle_stage, explicit alias family and full supplied history evidence. These are observations, not write payloads.

## Source contract and verification

Reviewed pinned source: `dasexperten/dasoperator` commit `16149d51389cbc4d625bbc8e26d766890e232c14`.
- [UGC router](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/routes/ugc.ts): platform normalization, actual profile fields, merge writes and importer limitations.
- [Rename checker](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/lib/ugc-rename-check.ts): exact history fields; confirmed renames preserve IDs.
- [Silent purge](https://github.com/dasexperten/dasoperator/blob/16149d51389cbc4d625bbc8e26d766890e232c14/api/src/lib/ugc-silent-purge.ts): crm_sync_state marker key/value/updated_at; historical records can be deleted.

Static source is not proof of deployment, executed merges, cleanup, current personal records or available safe handoff endpoint. The current importer hashes platform:handle and does not safely resolve historical identity. No live source reads or endpoint calls were made. No excluded private-capability files were read or changed.

Run synthetic adversarial tests with:

`node --test pilots/operational-storage/handoff-identity.test.mjs`

Adversarial tests include exact aggregate row/text budget boundaries, rejection one unit over before structuredClone, unrelated alias collisions, cycles/self-loops and a 9,998-edge ordered chain (the maximum total-row fixture). The chain test has a broad four-second regression threshold, not a runtime service-level guarantee.
