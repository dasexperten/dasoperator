# Detached atomic handoff candidate

Local nonproduction implementation only. Default off. No production route mount,
index, Wrangler/resource configuration, source/Sheet writer, outreach, publisher,
payout endpoint, grants, credentials, or authentication mechanism is added. No
production authorization integration is provided.

## Boundary and missing integration

Preliminary contact stays in Sheets. Transfer requires a genuine response plus
an authenticated deliberate substantive discussion decision under the existing
workflow. There is no new mandatory Owner approval. A caller's `approved` flag,
metadata, archive, or this fixture's source rows cannot authenticate that decision.

`createAtomicHandoffService({agent, config, db, verifyTrustedSource, timeoutMs})` and the detached
`createAtomicHandoffEndpoint` refuse work unless the selected agent is explicitly in shadow mode and supplied
with a trusted verifier. That verifier has **no production implementation**. It
must independently authenticate the existing workflow, bind genuine response and
discussion references and their versions, establish canonical identity and
complete source/deletion/DNC coverage, and maintain the coherent current source
projection. Its context comes from the integration, never a request body field.
The callback returns the exact authorized source key or rejects. This required
seam is not a new authentication scheme. Passing a permissive callback is unsafe
outside synthetic testing and does not make any metadata trustworthy.

Factory options and nested configuration require own data properties and reject
inherited settings, accessors, symbol/extra fields and global enabled flags.
The factory snapshots configuration. It uses the existing per-agent off/shadow
convention; enabling one agent never enables another. A request's agent and
namespace must exactly match the pinned selected agent and namespace.

One total asynchronous deadline covers body consumption, verification and DB
awaiting: default and maximum 5,000 ms, with trusted configuration allowed to
shorten it to 1–5,000 ms. Every awaited body chunk uses the remaining budget.
Body cancellation is best effort and not awaited indefinitely. A timed-out
verifier cannot later trigger DB dispatch. Once a DB batch is dispatched, a
timeout returns only an uncertain outcome and exact-key reconciliation guidance;
it does not cancel, undo or automatically retry the batch. Callback exceptions
are returned as fixed errors by phase, without reading arbitrary error.message.
This bounds asynchronous waits in a responsive JS runtime, not hostile synchronous
callbacks/event-loop starvation. The verifier must be read-only: the service
cannot cancel side effects performed internally by an untrusted callback.

Only `atomic-handoff.fixture-worker.mjs` supplies a permissive test double. The
opt-in test runner starts it on ephemeral loopback with an entirely local D1
binding, no persistent data and no production resources. Do not mount or deploy
that test worker. Production adaptation requires the missing independently
verified source/authority integration and a separately reviewed actual schema
and deletion contract; this candidate does not authorize that work.

## Request and transaction

Exact JSON fields are `namespace`, `agent`, `spreadsheetId`, `tabId`, `caseId`,
`sourceKey`, `checkpoint`, `identityVersion`,
`decisionVersion`, `manualStage`, `responseRef`, and `discussionRef`. All ordinary strings
are at most 1,024 code units (sourceKey is capped at 4,096), well formed and control-free. Only manualStage may
be empty. HTTP POST requires application/json and reads at most 8,192 bytes.
Unknown fields, including authorization flags and caller-selected ERP IDs,
are rejected. The sourceKey must equal the canonical JSON array
[namespace, agent, spreadsheetId, tabId, caseId]. tabId is a nonnegative safe integer;
the namespace and two agent names follow the existing pilot convention. This
explicitly binds one namespace/agent/spreadsheetId/tabId/case, independent of row position
and handle. The trusted source integration must establish that caseId is stable
and canonical, rather than accepting a freshly invented case identity. A missing
source row never creates a case. Request versions are opaque, equality-checked
checkpoints; they do not prove freshness by themselves.

A single INSERT into the durable source-key mapping runs validation and
creator/profile/collaboration inserts through SQLite triggers in a D1 batch.
The trusted projection also contains an explicit qualification state, which must
still equal substantive inside the transaction. Withdrawn/preliminary decisions
block even if discussion references remain nonempty. The same batch reads the
immutable mapping back. Trigger constraints execute
inside the transaction, closing the check/write gap for the fixture's source,
identity and manual-stage projections. Errors roll back the entire batch.
Concurrent exact requests converge on one mapping and one collaboration.

Existing identities use the actual creator/profile IDs supplied by the verified
projection, not hashes derived from renamed handles. Existing lifecycle stages,
including empty values and human decisions such as refused, are never rewritten.
Both stage and manual-decision revision must still match. New cards have only
empty lifecycle stage; agreement is never manufactured. A genuine replied
collaboration retains both evidence references. Unique collaboration IDs cannot
be silently reassigned from another source case. Explicit pre-insert conflict
checks also reject INSERT OR REPLACE across different source keys before SQLite
can delete an existing unique fence, with recursive triggers off. Preexisting
unmapped collaborations also cannot be overwritten by replacement.

ERP creator/profile/collaboration IDs in both projection and target rows require
1–256 printable non-space ASCII characters, enforced by SQL CHECK constraints
including explicit NUL rejection and TEXT storage type. This conservative local
contract fits the reviewed IDs; additional formats need separate validation.
Batch readback must contain two successful D1 results, no rows from the INSERT,
and exactly one SELECT row with exact source key/canonical request plus all three
valid IDs. Failed or malformed readback never reports transfer success; the
outcome requires reconciliation using the same source key.

A replay rechecks current source, exact input, identities, stage/revision,
exclusions and the retained collaboration, then returns the original IDs without
creating again. Missing source, unknown outcome, deleted/merged identity, changed
request, stale decision and conflicting exclusions fail closed. Mapping deletion
and updates are blocked; even INSERT OR REPLACE cannot replace a mapping.
There is no Sheet acknowledgment writer: acknowledgment failure is separate and
can only retry/read back the same mapping. An exception or lost response is not
proof of rollback; reconcile by the same source key and exact request, never a
fresh key. If current source/identity is no longer valid, stop for reconciliation.

## Synthetic schema limitations

`atomic-handoff.schema.sql` is a **test-only schema, not a production migration**.
It projects existing creator/profile/collaboration field shapes but deliberately
omits unrelated columns. `manual_revision` stands in for an atomic version of the
real manual-stage record. `atomic_aliases` represents a fully verified canonical
alias-to-profile relation, not a complete rename-history graph resolver.
`atomic_exclusions` combines independently verified purge/DNC/deletion markers.
`atomic_source` is a synthetic coherent source checkpoint including preallocated
actual IDs for new rows. It cannot be populated by the endpoint. The integration
must prove absence from all relevant live and deletion records before designating
an identity new. A missing production row alone is never such proof.

Only Instagram fixture coverage is accepted. Non-Instagram is blocked even with
`complete` metadata. Instagram coverage here is also merely synthetic: recurring
purge markers alone do not cover every deletion. Full production deletion and
merge coverage remains missing. No table or callback in this pilot establishes
that coverage or verifies genuine communication evidence.

## Verification

Run from repository root:

    node pilots/operational-storage/atomic-handoff.run.mjs

Uses the already-installed isolated Miniflare runtime and its loopback-only
preload, strips provider/account/token environment variables, disables cf network
metadata, denies worker outbound requests and asserts zero outbound attempts.
No remote database or endpoint is called. The default `node --test` invocation
runs the seven pure tests and skips the opt-in D1 suite.

21 tests pass against native local workerd D1: default off/missing integration,
strict inputs, concurrent exact retries, preserved canonical rename identities,
human stages and revisions, stale checkpoints/decisions, alias exclusions,
unsupported or incomplete coverage, unknown/deleted states, late-conflict atomic
rollback, discarded committed response/readback, simulated separate acknowledgment
failure, changed/merged profiles, absent source after commit, immutable fences,
trusted-verifier rejection, bounded body, inherited activation/configuration mutation, wrong agent/source scope,
decision withdrawal, slow body/verifier with no late writes, dispatched DB timeout,
sanitized arbitrary callback failures, combined body/verifier deadline, failed or
malformed batch readback, cross-source REPLACE preservation, invalid-ID transaction
rollback and no outbound effects. The total is 7 pure tests plus 14 native D1 tests.

Response-loss testing deliberately discards a completed response; it is not a
power-loss or distributed-failure durability claim. Separate acknowledgment
failure is modeled as absence of a Sheet action, not a working Sheet adapter.
Tests establish native D1 transaction behavior for these synthetic shapes only,
not deployed authorization, genuine discussion, complete deletion coverage, live
readiness, migration completion or permission to enable anything.

The late-rollback regression uses a fixture-only BEFORE INSERT collaboration
trigger for a fresh unique collaboration ID. It first proves creator, profile
and mapping inserts are visible, then raises ABORT. Endpoint rejection leaves
all four rows absent, while full snapshots of source and unrelated fixture data
remain unchanged. A separate early-collision test verifies rejection before
creation; that is not counted as proof of late transactional rollback.
