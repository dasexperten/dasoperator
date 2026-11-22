# Bounded local merge/delete integration checkpoint

Status: local-only alternative, not mounted or deployed, no production migration,
no credentials or authorization implementation. Existing accepted handoff source,
persistence, schema and atomic service are unchanged. Review before any adoption.

Run `node pilots/operational-storage/erp-remap.run.mjs` from repository root.
Fifteen tests (fourteen native Miniflare/D1 and one malformed-readback unit case) compose the full pinned UGC purge schema, the
alternative handoff schema, mapping model and the enrolled manual revision gate.
Supported composition order is explicit: composeManualRevisionHandoffSchema
first, then composeRemappingHandoffSchema from erp-remap.compose.mjs. The first
pins the accepted guard hash; the second pins the exact manual-composed guard
hash. Both insert checks inside that same trigger before replay RAISE(IGNORE),
avoiding dependence on unspecified ordering of separate BEFORE triggers.
Retained alias validity and exclusions also apply to exact replay and include
actual selected-profile old/new aliases, even if live history returns to its
original snapshot after a conflicting mapped card is purged.
The runner strips credentials, denies non-loopback process networking, disables
metadata fetch and rejects/counts worker outbound requests (zero expected).

## Concrete implementation path

`composeRemappingHandoffSchema` requires exact known accepted schema fragments
and explicitly substitutes historical references for the original immutable
fence's live UGC foreign keys. It adds the initial mapping/event in the original
handoff creation transaction, after the real creator/profile/collaboration writes.
The historical source-case row remains permanent and immutable. Deferred live
foreign keys move to `pilot_erp_case_mapping`; nothing disables foreign keys.
Initial revision zero and subsequent merge/delete events remain append-only.
This preserves immutable identity/evidence and selected human-state snapshots,
not a complete archive of every deleted row, metric, content item or communication.
Original purge deletion semantics remain destructive for eligible rows.

At the existing authorized merge route's batch boundary only,
`mergeIntentStatements` wraps its original statement list with a transaction-local
intent and final intent consumption. Keep the existing requireAccess and body,
platform and identity validation unchanged. Intent rows cannot commit unresolved:
a deliberately unsatisfiable deferred FK requires consumption, and consumption
requires the source creator actually removed. Database possession/intent rows do
not authenticate an operator and must never be exposed to request metadata.

Profile deletion under explicit merge intent records original IDs plus actual
current human stage, notes, origin, accepted_at and exact manual JSON/timestamp,
then advances the mapping to the actual surviving creator/profile. The original
merge SQL still moves content, collaboration, source records and payouts, records
aliases and removes the old card. It does not merge human stages or overwrite the
survivor's fields. Old manual records remain where the original route leaves them.
Existing old-profile history FK blockers still yield full rollback; this does not
silently repair or migrate that legacy history behavior.

For the recurring purge, `currentEligiblePurgeStatements` wraps each original
creator's exact statement list. Its leading INSERT SELECT re-evaluates the pinned
eligibility predicate inside that same destructive transaction. An explicit
transactional assertion aborts before the marker/deletions if no current intent
was created, including for unmapped creators. The unwrapped legacy path is unchanged. A mapped replied
case no longer qualifies, gets no intent, and its earlier collaboration/history
DELETE aborts the whole marker-first batch. Before the original history DELETE, an immutable alias ledger retains the exact
known old/new handles and full actual history-row JSON in the same transaction,
linked by deferred FK to the forthcoming deletion event. A later failure rolls
back both the alias ledger and original deletions. Eligible mapped deletion records a
permanent tombstone and history; unmapped legacy deletion remains unchanged.
This is a scoped integration point, not a generic user-authorized deletion API.
Other cleanup/manual-delete paths remain blocked for mapped rows until separately
integrated and reviewed. A batch with one protected creator can still roll back
all rows: callers need existing failure reporting and explicit reconciliation.

`resolveStoredHandoff` is read-only canonical identity reconciliation and labels
its result `resolutionOnly:true`. It can resolve a committed merge after a lost
response to the real survivor, preserving source-case identity and revision.
It is NOT a new successful handoff receipt, source verifier or authorization.
Caller authentication and fresh trusted source/manual observation are mandatory
before any subsequent ERP mutation. The unchanged original transfer entrypoint
fails after a merge instead of recreating original IDs. Deleted or unknown source
outcomes reject. Retired creator/profile IDs from merge/delete events and known
deleted handles remain reserved across fresh source keys, preventing a renamed
source projection from recreating a retired identity. Retained known rename
aliases also block fresh-ID reuse after original handle-history rows are deleted.
Noncanonical or cross-platform retained history is preserved verbatim and blocks
fresh handoffs pending investigation, without silently normalizing or discarding it.
This does not discover unknown aliases or establish complete deletion coverage. Tombstones cannot return to active, and mapping/event replacement
is rejected. No Sheet acknowledgment is added or inferred from resolution.

## Pinned evidence and tests

Commit: `16149d51389cbc4d625bbc8e26d766890e232c14`.
Exact route fixture retrieved read-only through GitHub connector:
`erp-handoff-fixtures/ugc-merge-pinned.ts`, Git blob
`4b5d146e3dda20a6617189b20fd2b1780899768e`.
Exact purge fixture: `erp-remap-fixtures/ugc-silent-purge-pinned.ts`, Git blob
`26c9f48329f25220ff1daf395f29ad536d695623`.
Both are hash-verified before tests. Merge and purge statement lists are extracted
from those exact source files, not rewritten CRUD simulations. Full
`erp-remap-fixtures/purge-schema.sql` is checked against the accepted source
manifest's SHA256. No historical data migrations or live deployment are simulated.

Tests cover relocated live FKs; original merge without intent full rollback;
exact integrated merge with children, payout note, provenance links and survivor
fields retained; old manual state/history retained; exact stale purge rollback;
current-eligible purge tombstone and no replay resurrection; uncommittable intent;
unchanged original history FK failure; unknown outcome block; unmapped deletion;
combined manual ABA gate; lost merge-response same-source reconciliation; and malformed authoritative readback rejection.

## Remaining gates and limits

- The manual revision schema is composed in this suite: source observation pins
  enrollment revision before handoff and ABA of manual-record bytes is rejected.
  This does not prove monotonic lifecycle-stage history for writers which change
  lifecycle_stage without changing the manual record. It does not transfer old
  manual decisions to a survivor or approve a new decision after merge.
- Source completeness, deletion/DNC coverage, stable source-case allocation,
  authenticated response plus deliberate substantive discussion, actual IDs and
  coherent source/manual observation remain unimplemented production gates.
  Synthetic fixture assertions are not authority. Preliminary work stays in Sheets;
  reply alone never qualifies. Non-Instagram handoff remains blocked.
- Route wrapper placement, current deployed schema/writer compatibility, migration,
  retention/privacy policy for permanent historical human snapshots, access,
  production resource isolation and explicit rollout approval remain outstanding.
  No production route, public auth design, remote resource, publication, contact,
  payout execution, deployment, commit or Git push was performed.
- Original merge profile/alias selection occurs before its batch and retains its
  existing race behavior; this checkpoint does not claim to fix all legacy writer
  races. Whole-table source history and other original conservative gates remain.
- A database-binding holder could forge coordination rows or replace triggers;
  these are integrity safeguards within the reviewed writer contract, not a
  security boundary. No endpoint accepts arbitrary SQL or intent metadata.
