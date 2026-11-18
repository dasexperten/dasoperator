# Local handoff persistence against pinned ERP schema

Status: detached, disabled nonproduction candidate. No production route,
resource configuration, migration, credentials, authentication implementation,
Sheet acknowledgment, contact, publication or payout action is added. Existing
accepted atomic-handoff modules remain unchanged.

## What runs

`createErpHandoffPersistence(db)` is a narrow persistence bridge for the existing
`createAtomicHandoffService` / `createAtomicHandoffEndpoint`. It accepts only the
two exact normalized INSERT/readback statements that service emits, translates
their detached table names to `pilot_erp_source` and `pilot_erp_handoffs`, and
requires the matching two-statement batch. Unexpected SQL or mixed source keys
reject. It is not an alternate generic database interface or an authority boundary.
Use it only inside the existing service; possession of a database binding is not
proof of authority or isolation.

The accepted service retains own-property, snapshotted, per-agent off/shadow
configuration; exact namespace/agent/spreadsheetId/tabId/caseId identity; strict
request validation; required trusted verification; bounded total lifetime; and
strict authoritative readback. The new persistence layer does not implement or
replace the missing trusted verifier. Only the loopback fixture worker supplies
an intentionally non-authentic echo test double. Never mount or deploy it.

The fixture projection is explicitly synthetic. Its `complete`, `substantive`,
`current`, version, DNC/deletion state and evidence assertions do not authenticate
anything. Real authenticated qualification/source integration remains a missing
production gate. A response plus deliberate substantive discussion is required
under the existing workflow. There is no new per-case Owner approval requirement.

## Actual pinned source, not surrogate UGC tables

Fixture DDL comes from dasexperten/dasoperator commit
`16149d51389cbc4d625bbc8e26d766890e232c14`, retrieved through the authorized GitHub
connector. `erp-handoff-fixtures/manifest.json` preserves source paths, commit,
Git blob hashes, SHA256s and extraction statement references. The copied
`handoff-schema.sql` is verified against that manifest's SHA256 at test startup.
It contains exact relevant CREATE/ALTER/index/trigger statements, not rewritten
column definitions. `handoff-schema.shape.json` independently records column,
index and FK shapes. Tests compare all actual columns/defaults against that shape.

The audit extracted only schema statements necessary for this test. Historical
data remapping, accepted_at backfills, cleanup DELETEs, unrelated tables and
migration history execution are not simulated. In particular the real database
DEFAULT remains `found` on creators and collaborations, despite earlier data
cleanup migrations. The adapter explicitly inserts the truthful empty creator
stage and `replied` collaboration status instead of relying on those defaults.

The native isolated workerd D1 tests create the real `ugc_creators`,
`ugc_creator_platforms`, `ugc_collaborations`, `ugc_handle_history`,
`crm_sync_state` and associated triggers. No atomic_creators/profile/collaboration
copy tables exist. The only new candidate tables are the detached synthetic source
projection and immutable handoff fence. This schema is never applied remotely.

## Transaction and identity invariants

The mapping INSERT checks and writes inside one D1 transaction. New identities
use the exact preallocated actual IDs from the verified projection, not handle
hashes. Existing identities retain original IDs, creator/profile fields, notes,
origin, accepted_at and lifecycle stage without any UPDATE. New creators retain
empty stage and NULL accepted_at; no agreement or accepted-at trigger is fabricated.
The collaboration has genuine `replied` status and real timestamp/creator/platform
columns. No nonexistent response_ref/discussion_ref UGC columns are invented:
the exact qualifying references and decision checkpoint remain in immutable
handoff request_json. This candidate does not add a production UI for that fence.

The real manual decision lives at `crm_sync_state.key = manual_stage:<creator_id>`.
The transaction compares exact raw JSON and updated_at against the observed
projection, including explicit absence. Present records must parse with a string
`to` equal to the unchanged stage and numeric `at`, matching the real parser's
minimum meaningful fields. A reviewed record remains a human decision. No
reviewed_at requirement, approval flag or manual-revision UGC column is invented.

History is read from actual `ugc_handle_history` rows. A conservative whole-table
JSON checkpoint prevents changes between source observation and transaction,
including unrelated history changes. Before JSON construction or recursive SQL,
the local gate rejects more than 2,000 total history rows, more than 64 edges for
the selected profile, any history field over 4,096 UTF-8 bytes, or total history
field bytes over 1 MiB. Projection history_json is separately capped at 1 MiB.
Nothing is truncated. These conservative caps are testing/integration gates,
not a production capacity claim. Source/current handles, actual Instagram normalized profile handles, history
aliases and purge-marker suffixes must be canonical lowercase ASCII Instagram
handles: 1–30 letters/digits/underscore/dot, no leading/trailing or consecutive
dots. Blank, whitespace, control, uppercase, @-prefixed, hyphenated, ambiguous or
otherwise noncanonical input fails closed, without rewriting real data. A
noncanonical actual row/marker blocks even if unrelated, requiring investigation.
This deliberately conservative local contract does not normalize or infer aliases.
Old source handles must reach the actual
current handle through same-profile/platform edges. Cycles, disconnected edges,
competing current profiles and overlapping history families reject. Purge markers
at `ugc_purged:instagram:<handle>` block current, original and all historical
old/new handles, regardless of marker value. Archived creators and unavailable
profiles block. Unsupported non-Instagram coverage, withdrawn decisions,
unknown outcomes and excluded/deleted source states block.

The fence retains enforced deferred FKs to actual creators/profiles. A stale
production-style purge deletion batch selected before handoff cannot delete a
newly protected card after handoff: FK failure atomically restores deleted
history, collaboration, profile and creator, and rolls back its purge marker.
This is a local compatibility result, not a deployed purge fix. Production purge
code is unchanged; adding such FKs would require separate migration review and
operational handling of the resulting failed batch. The same FKs also block
legitimate existing merge/deletion routes that remove mapped creators/profiles:
those routes do not know this immutable fence. A whole purge batch can roll back
when one protected identity is encountered. Thus this is not a drop-in migration;
merge/deletion/remapping/retention integration is an explicit production gate.

Exact retries revalidate current state and return the same actual IDs. Missing,
merged, deleted, conflicting, stale or uncertain identities never become a fresh
case. Changed collaboration status/ownership or accepted_at fails replay rather
than overwriting subsequent ERP work. Sheet acknowledgment is not implemented;
no acknowledgment is inferred before authoritative readback. A lost/unknown DB
response requires same-source reconciliation, never a fresh allocation.

## Exact blockers and limits

- **No monotonic manual revision exists.** Real crm_sync_state uses ordinary
  overwrites of raw value and integer timestamp. Exact-state CAS detects current
  differences, but cannot detect changed-then-restored identical value/timestamp
  (ABA), deletion/recreation with identical bytes, or prove a monotonic history.
  No source metadata can repair this guarantee. If a workflow requires that
  revision invariant, enabling it remains blocked until a separately authorized
  durable version/history contract and all writers are integrated. This candidate
  does not claim production revision safety or silently add fictitious columns.
- Authenticated substantive qualification, complete source/deletion/DNC coverage,
  stable source-case assignment and authoritative new-ID allocation are still
  missing production integrations. Recurring Instagram markers do not prove
  coverage of every cleanup, manual deletion, merge or upstream history loss.
  Non-Instagram always blocks.
- The pinned schema is a static source contract, not proof of deployed versions,
  live state or schema migration compatibility with every existing writer.
- A trusted verifier is read-only and must not perform external effects. Timing
  limits cannot interrupt synchronous JS starvation or cancel an already-dispatched
  D1 batch. Such outcome remains unknown. No test claims power-loss durability.
- Whole-table history snapshots are intentionally conservative and not a claimed
  production-scale query plan. No local-only metadata assertion is authorization.

## Verification

From the repository root:

    node pilots/operational-storage/erp-handoff.run.mjs

Uses the existing opt-in local Miniflare runtime, strips provider credentials,
blocks non-loopback process networking, disables external metadata fetch and
counts/denies worker outbound requests. No network action or remote D1 occurs.

Current suite: **16 tests: 1 pure and 15 native D1**. Coverage includes pinned
schema/default parity, default-off/missing integration, genuine new blank-stage
creation, canonical renamed identity and full field preservation, concurrent
replay, current manual-state/stage/archive/availability conflicts, invalid manual
records, historic/current purge markers, history changes/cycles/collisions, late
transaction failure after actual creator/profile inserts, lost-response readback,
uncertain source, stale purge rollback, deletion/DNC/qualification/coverage and
unsupported platform failures, canonical handle/alias/marker rejection, bounded
history, real-schema cross-source REPLACE, missing source and changed collaboration.
The stale-purge regression mirrors the actual marker-first deletion order. Existing atomic suites separately cover inherited
activation, malformed input/readback, bounded total lifetime and cross-source
replacement; the accepted implementation is reused unchanged, not recounted here.
