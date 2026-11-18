# Disabled local handoff recovery journal

This is local bookkeeping for a future reviewed Sheets → ERP handoff, not a transfer implementation. It is off unless the existing pilot configuration explicitly selects `shadow` for `angela` or `diana-helios`. It is Node-only and accepts a caller-owned `node:sqlite` `DatabaseSync`. It does not open a database, install its schema, invoke a callback, access the network, write Sheets/CRM, create a card, change a stage, acquire credentials, expose a worker route, or grant permission. It makes no Cloudflare/D1 compatibility claim.

All returned reports carry `localBookkeepingOnly: true`, `cutoverReady: false`, `liveWrites: false`, `executionAuthorized: false`, `actions: []`, and `integrationStatus: 'unimplemented'`. These are explicit prohibitions, never execution capabilities.

## Business boundary and missing integration

Preliminary comments/contact remain in the existing Sheets. A response alone is insufficient. The eventual ownership boundary requires a deliberate qualification decision after substantive discussion. `manualStage` is copied exactly, including the valid empty string. Nothing infers or sets `agreed`.

`sourceAssertion`, `decisionAssertion`, and every observation are **unverified local metadata assertions**. The module checks shape, exact binding and internal consistency only. Reviewer IDs, dates and provenance references are strings, not authentication. A planner result is not independent authorization and cannot be passed directly as a journal request. There is no production qualification-decision verifier, authenticated principal, current source reader or live ERP readback.

Real stable source case IDs, authenticated qualification-decision provenance, complete field mappings, installed integration versions and live source coverage remain **UNIMPLEMENTED**. Tests use explicitly fictional identifiers. Before any separately authorized future transition, independent upstream integration must establish current source state, DNC/purge state, unique mapping, substantive decision, checkpoint and manual stage. Journal rows cannot satisfy those gates.

ERP IDs are explicit opaque identities, never derived from handles. The journal cannot verify renamed/merged/deleted cards, recreate missing cards, deduplicate the same person across agents or tabs, or establish current ERP existence. Its per-agent ERP uniqueness constraint only prevents two different reservations in that agent/namespace from claiming the identical opaque ID. It does not prove different IDs represent different people. Known mapping reconciliation still requires live verification elsewhere.

## Immutable reservation

`reserve` takes exactly:

- `reservationId`: caller-selected local idempotency identity.
- `binding`: `{agent, spreadsheetId, tabId, caseId, threadId, checkpoint, manualStage, responseId}`.
- `sourceAssertion`: `{state: 'current', doNotContact: false, purgeMarker: null, relationship: 'unmapped', actionOutcome: 'settled', responseId}`. The response ID must match the binding.
- `decisionAssertion`: `{kind: 'substantive', decisionId, reviewerId, decidedAt, provenanceReference, binding}`. `decidedAt` is canonical ISO UTC with milliseconds; the nested binding must exactly match the outer binding.

The namespace comes only from the pinned configuration. `spreadsheetId` and `tabId` preserve the planner's source identity names. For a future separately reviewed adapter, these correspond to planner `binding.source.spreadsheetId/tabId`; `caseId`, `threadId`, `checkpoint` likewise come from `binding.source`; `responseId` corresponds to `binding.reply.id`. This is a documented field correspondence, **not** an implemented planner-to-journal adapter or proof of provenance. The narrower journal binding is not a substitute for the planner's URLs/handle/source metadata or full future mapping contract.

The permanent fence is `(namespace, agent, spreadsheetId, tabId, caseId)`, deliberately excluding checkpoint and attempt ID. A new checkpoint, changed decision/manual stage, or new reservation ID cannot evade an existing fence. Historical, absent, unknown, purged, DNC, mapped or ambiguous candidates and unresolved prior external outcomes cannot obtain a new reservation. Exact replay of the original input returns the existing reservation and its latest observation. `replay` is a boolean derived from SQLite's insert result.

There is no expiration, release, cancellation, reset or fresh-attempt method. Even the initial `reserved_outcome_unresolved` state blocks a fresh attempt. Failure before an insert leaves no fence; if a caller is unsure whether insertion committed, it must replay the exact input. Losing a database itself is outside the guarantee; a future durable store/backups/recovery design is required before any real handoff. Core tests use memory; the separate file fixture suite uses disposable local SQLite files and synthetic data only. Never treat a restarted empty test database as evidence no ERP action occurred.

## Append-only observations

`observe` takes exactly `{agent, reservationId, observationId, expectedSequence, kind, erpCaseId}`. Observation values remain unverified assertions; there is intentionally no `verified` or `authorized` flag. `read` takes `{agent, reservationId}`. Reports expose named binding fields and the unchanged manual stage.

1. A reservation starts at sequence 0, `reserved_outcome_unresolved`.
2. `erp_unknown` and `erp_in_progress` append uncertainty with a null ERP ID. Neither clears the fence or permits another attempt.
3. `erp_identified` records an explicit opaque ERP ID. It may follow a reservation or uncertainty. It establishes a local assertion, not verified external success.
4. Thereafter only `sheet_ack_failed` or `sheet_acknowledged` can be appended, always with that same ERP ID. A failed Sheet acknowledgment preserves identity. Repeated failure observations can be recorded while reconciling that same mapping; they are not commands to retry a Sheet write.
5. `sheet_acknowledged` is terminal for new observations. Exact replay of any previously recorded observation remains possible and returns the **latest** state, not an old state that could erase later knowledge.

An observation ID is immutable within the reservation. Replaying it requires exactly its original expected sequence, kind and ERP ID. A conflicting replay fails. Every new observation supplies the current sequence. An atomic SQLite insert plus triggers enforces the next sequence, valid state transitions, reservation presence, terminal status and permanent ERP identity. Competing stale writers cannot overwrite one another. SQLite triggers reject mutation/deletion and protect against `INSERT OR REPLACE`, including with recursive triggers disabled. These are consistency fences, not defenses against a database administrator who can drop schema or remove the file.

A database busy/error or lost response is not evidence of failure. Inspect local state and replay the exact request. Never respond to uncertainty by allocating a fresh attempt or another ERP case. If different ERP identities are observed, stop for independent reconciliation; this journal will not overwrite the old identity.

## Tests

Run from this directory with Node 24 (the exercised runtime was v24.22.1):

    node --import ./no-network.mjs --test handoff-recovery.test.mjs handoff-recovery.file.test.mjs

The 10-test core suite applies the candidate schema only to real in-memory SQLite, with no external data/IO beyond reading the local SQL fixture. It covers disabled mode, strict inputs, exact two-agent scoping, source eligibility, decision/response/checkpoint binding, exact reservation replay, concurrent scheduled contenders through independent journal instances, stale-sequence conflicts, lost responses after actual commits, irreversible fences, retained mapping after Sheet acknowledgment failure, terminal exact replay, empty manual stage, mapping collision and SQL mutation/replacement protection. Scheduled contenders share one SQLite connection; this is an atomic consistency/stale-writer test, not a multi-process crash, lock-contention or durability proof.

The additional 2-test file suite uses independent Node Worker threads and independent SQLite connections to a temporary local file. Workers synchronize before competing writes. It verifies exactly one initial reservation plus exact replays, rejection of a fresh attempt, and exactly one accepted observation at a shared expected sequence. A worker also commits the reservation, explicit ERP identity and Sheet acknowledgment-failure observation, then exits without returning operation results. The parent reopens the file and verifies exact replay, retained ERP identity/fence and unchanged row counts before acknowledging only the same mapping.

Parent and workers explicitly load the no-network preload; the shared fixture additionally blocks DNS, datagrams and higher-level network entrypoints. Both contexts verify the guards before SQLite work. Each worker has a 10-second termination deadline and 5-second synchronization wait; each file test has a 20-second timeout. Connections close and temporary directories are removed after tests. No external binaries, services, credentials or real business data are used. These two tests establish file reopen/worker-exit recovery and competing-connection consistency, **not power-loss durability**, production readiness or Cloudflare/D1 compatibility. Total: **12 tests** across both suites.

No schema application outside tests, production wiring, CI activation, upload, live transfer, cutover or permission change is included.

Who may assess qualification is determined by the existing authorized workflow,
not this journal. It does not impose a new Owner confirmation on every case or
permit an agent to override a human-set stage. Reviewer metadata is not authority.
