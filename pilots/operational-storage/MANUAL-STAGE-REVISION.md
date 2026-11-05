# Local manual-stage revision fence

Detached, default-off, synthetic native D1 candidate. Not a deployed migration,
route, source authenticator or authorization boundary. Existing accepted handoff
files and their raw-state, lifecycle, qualification, identity, purge and history
checks remain unchanged. No existing UGC columns are added or imagined.

## Explicit enrollment and baseline

`createManualStageRevision(db, {namespace:'pilot-erp', agent:'angela', enabled:true})`
exposes only `enroll(creatorId)` and `observe(creatorId)`. Omitted/false enablement
is off. Only exact pilot namespaces and Angela/Diana agent names are accepted.
Enrollment is deliberately one canonical creator identity at a time, with one
immutable namespace/agent owner per creator. Other scopes cannot adopt/reset an
existing enrollment. Shared cross-agent creator enrollment is not implemented.
The caller must have already resolved and authorized that identity; this helper
neither proves identity nor grants authority. No blanket card/agent enrollment.

Enrollment atomically establishes revision zero and observes either exact current
`crm_sync_state` value/timestamp at `manual_stage:<creator_id>` or explicit absence.
It claims **no history before this baseline**. Retrying enrollment reads the
existing revision, never rebaselines. There is no unenrollment/delete/reset API.
Metadata survives deletion of the underlying creator/manual record and is not
cascaded away. Retention and migration of that metadata need production review.

## Semantics across unchanged existing writers

AFTER triggers on the actual three-column `crm_sync_state` table maintain a
separate observation table. Existing manual JSON, timestamps, notes and stages
are never rewritten. Non-enrolled keys gain no records. The implementation scans
only enrolled observations after CRM writes; this conservative local algorithm is
not a production throughput claim.

- A raw value or timestamp change advances revision. Restoring the exact previous
  bytes/timestamp advances it again. Values are not parsed or normalized here.
- A successful INSERT/REPLACE of an enrolled key advances revision, even if the
  final bytes match. That is a conservative row-incarnation event.
- DELETE/recreation advances for both observed transitions. Key movement and
  UPDATE OR REPLACE target incarnation are tracked, even with identical values.
- A rowid-collision replacement can implicitly delete a different enrolled key.
  Reconciliation detects that deletion with recursive_triggers OFF too.
- Same-state UPDATE, ignored insert, conflict DO NOTHING, false UPSERT WHERE and
  deletion of an absent record do not create events. UPSERT's attempted INSERT
  does not increment; only its executed UPDATE's meaningful effect does.
- Statement/transaction rollbacks roll back revisions and enrollment with data.
  Revisions order committed observable transitions, not attempted operations.
  With recursive_triggers ON, REPLACE may also expose its implicit DELETE and
  produce an additional increment. Consumers compare equality, never assume a
  fixed number of increments or infer how many human actions occurred.
- Safe-integer exhaustion aborts the mutation instead of wrapping or silently
  ignoring observation loss. This intentionally fail-closed exceptional condition
  needs operational handling before production. No full historical event log is
  stored, only durable monotonic counter and latest raw observation.

## Bounded actual handoff integration

`manual-stage-revision.handoff.schema.sql` adds a separate source-key checkpoint.
The Node-only `composeManualRevisionHandoffSchema` helper verifies the exact
accepted BEFORE guard's SHA256 and adds the revision predicate inside that guard,
before its replay `RAISE(IGNORE)`. This explicit composed alternative leaves the
accepted source file untouched and rejects drift or double composition. A separate
BEFORE trigger is unsafe because replay IGNORE can skip subsequent triggers;
recreation/order regression tests cover this. Compose the result with the remap
alternative in one supported order: this manual composer first, then
`composeRemappingHandoffSchema` from `erp-remap.compose.mjs`. The latter verifies
the exact manual-composed guard before adding retained-identity checks. Reversed
order, drift and double composition fail visibly. The gate
requires exact namespace/agent, creator and pinned revision, plus consistent
current raw observation. Existing raw-state and human-stage guards still run.

A future trusted source integration must enroll deliberately, observe revision
**at the coherent substantive-discussion/manual-state checkpoint**, and persist
that exact revision with the immutable source-case evidence. The existing actual
handoff INSERT checks it in the same transaction as creator/profile/collaboration
writes. Reading a fresh revision just before transfer to bless old qualification
would defeat the guarantee and is not permitted by this contract. The fixture's
checkpoint rows are synthetic assertions, not authenticated evidence. The test
that refreshes a checkpoint models explicit source re-observation only; no live
source requalification or automatic transfer is added.

A stale replay rejects after an intervening manual change, including ABA. An
unknown response must reconcile the same source and creator; it must not allocate
a fresh enrollment or case to bypass a stale revision. Merge/remap integration
must preserve the original creator revision history and explicitly establish any
new identity baseline; it cannot pretend that a new baseline captured old history.
The separate merge/deletion integration remains responsible for its fences.

## Limitations and verification

All writers using the same actual table are observed only while this schema and
its triggers remain installed. Direct metadata/DDL tampering, backup restoration,
other databases or a writer bypassing this table are outside this primitive's
trust boundary. A database-binding holder is not authenticated by these helpers.
There is no production permission/grant or trusted-source implementation. The
pinned schema is static, not evidence of deployed schema or current live records.
No production scalability, power-loss durability or deployed writer compatibility
is claimed. Existing source/authentication/qualification/purge coverage gates stay.

Run from the repository root:

    node pilots/operational-storage/manual-stage-revision.run.mjs

The runner uses existing pinned local Miniflare, stripped environment, loopback
transport only, denied Worker outbound access, fresh nonpersistent synthetic D1,
and SHA256-verified actual UGC fixture schema. It covers baseline, raw/timestamp
ABA, deletion/recreation, REPLACE with recursive triggers OFF, noop/UPSERT ordering,
key/rowid collisions, enrollment retries/concurrency, scope, rollback and actual
handoff integrated gating, strict schema composition and recreated/reordered guards. No remote commands or credentials are used.
