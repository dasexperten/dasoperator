# Detached nightly observation → archive receipt adapter

New candidate module: `nightly-archive-receipt-adapter.mjs`.

`createNightlyArchiveReceiptAdapter({config, capture, ledger, authorize, verifySnapshot}).observe(event)` consumes the unchanged event emitted by the real organization `createNightlyCanonExporters` optional observation seam. This is a detached module, not runtime wiring or permission to turn on the exporter seam. Only new module/tests/documentation were added. Existing capture/store/ledger and real exporters remain unchanged by this addition. No private-capability component was inspected or used.

## Trust and validation

Configuration must explicitly enable shadow mode for exact angela or diana-helios in the event's exact pilot namespace; otherwise the adapter fails closed. Only org_task_runs and agent_chat_messages are accepted. The event must contain exactly namespace, sourceTable, agent, observedAt, rows, rowsJson, snapshotSha256, selection. Selection strings are exactly the real exporter contract:

- org_task_runs: pending_runs_join_task_title
- agent_chat_messages: oldest_500_undistilled_chat_projection

The adapter checks the complete group before any writes: each positive safe integer row ID is unique, agents match, required capture fields exist, every unknown selected field is retained, row data is strict JSON-safe plain data, and rowsJson equals the real exporter's recursively key-sorted JSON.stringify representation. Arrays retain order; meta strings are opaque. Symbol/non-enumerable/accessor properties, sparse arrays, non-finite numbers, unsafe integer numbers, excessive nesting and non-JSON values are rejected rather than dropped. This cannot recover precision already lost by a source driver; it rejects observable unsafe integers, and makes no raw database representation claim.

The group hash is SHA-256 of UTF-8 JSON.stringify({namespace, sourceTable, agent, rowsJson}) in precisely that property order. observedAt is descriptive and excluded. Hashes establish correlation and consistency, **not authorization or independent source verification**. All event data is detached before the first await.

Mandatory authorize receives a frozen scoped locator plus operation archive-nightly-observation and must return exactly true based on trusted authenticated identity. Mandatory verifySnapshot receives only a frozen locator {namespace, agent, sourceTable, selection, snapshotSha256}. It must independently resolve a trusted immutable source checkpoint and return exactly {namespace, agent, sourceTable, selection, rowsJson}. Each returned field must equal the event. It receives neither the event rows nor expected rowsJson. Returning true, approved/verified flags, or merely hashing caller rows is insufficient. A hostile application can still install a dishonest callback; trusted application construction and source-checkpoint provenance remain explicit integration gates, not a capability supplied by this module.

The existing capture's own sourceVerifier and store authorization remain independently required by those unchanged components. The fixture's allow-all sourceVerifier/auth functions are local test stubs, not production grants.

## Per-row pipeline and interruption semantics

After complete validation, independent verification and all per-row hashes are prepared, the adapter processes selected rows sequentially:

1. Existing capture.captureD1Row archives JSON.stringify of each detached canonical selected row, with checkpoint `nightly-snapshot:<snapshotSha256>` and SHA-256 of that exact row string.
2. Existing ledger.recordReceipt independently reads the resulting archive through the store and verifies manifest/content identity before recording a receipt.

These bytes are the exact canonical row representation of the selected observer event. They are not claimed to be original source SQL wire bytes or a full row beyond the exporter selection. The task selection contains r.* plus joined title; the chat selection omits distilled_at and potentially other database columns. Unknown selected fields, human-set stage/manual-review metadata, pre-agreement scouting notes, Telegram message IDs, choices and callback receipts remain opaque, not operations.

The result includes snapshot hash, deterministic checkpoint, per-row IDs, capture/receipt states, verified manifest/receipt IDs when known, replay flags, and overall status:

- complete: every row returned a verified receipt.
- partial-or-unknown: capture or receipt threw, returned a disabled/skipped/malformed result, or could not be established. That row is unknown for the affected stage; subsequent rows are not-attempted. Already verified rows remain reported. Errors are conservatively unknown even when a failure may have happened before committing.

The adapter stops on the first uncertainty. It never automatically retries, restarts source exporters, repeats Git actions, changes exported_at/distilled_at, creates UGC cards, processes choices/callbacks or activates primary mode. Explicitly resubmitting the identical original event reuses the same checkpoint and immutable per-row identities. Store and ledger readback reconcile committed-but-lost responses. Resubmission must independently authorize and verify the checkpoint again. A changed observedAt alone does not alter identity; changed rows/order/markers do, and must never be described as an exact retry.

## Runtime and resource limits

There is no internal timeout, detached scheduler or durable queue. A caller that awaits observe gets a definitive returned report only when processing finishes. Caller/runtime interruption or the real exporter's observer timeout can leave a committed prefix or an unresolved in-flight write; it cannot imply rollback or completion. Retain the original event plus trusted checkpoint outside this module if an authorized future runtime needs durable reconciliation. Do not restart the source action to reconstruct it.

**The exporter ignores the observer's returned value. Its observer_returned diagnostic only means the callback settled successfully; it does not mean this adapter returned status complete.** An integration must retain and inspect the adapter result separately. An exporter timeout reports unknown and does not cancel an already-running adapter. Runtime lifetime management, durable scheduling, explicit result retention, and late-result/uncertain reconciliation policy remain unimplemented integration gates.

Limits: 1–500 rows, at most 1 MiB UTF-8 rowsJson, depth 100, and a conservative 1 MiB structural character/node budget for the supplied rows. A valid export observation can be rejected by the stricter structural budget. Writes are at most one capture attempt and one receipt attempt per attempted row per call. Group verification is not a transaction: archives may exist without receipts on partial failure. Ledger current projections separately fail closed above 32 receipt revisions or 32 MiB archived payload history per source row. This adapter does not prune, paginate or silently waive those history limits. Repeated changed groups may eventually hit that projection gate.

No live database grants, bindings, source imports, schema application, deployment, source-marker changes or exporter wiring are included. No result claims ERP-primary authority, verified delivery or cutover readiness.

## Local tests

`node --import ./pilots/operational-storage/no-network.mjs --test ./pilots/operational-storage/nightly-archive-receipt-adapter.test.mjs`

Tests use real SQLite, unchanged capture/store/ledger, fake R2 and blocked network. They cover complete validation before writes, off/auth and independent reader requirements, tampering/cross-scope/duplicates, selected unknown/meta preservation, concurrent exact replay, observedAt semantics, lost manifest and receipt responses, pre-insert/R2 errors, limits/non-JSON/accessors/unsafe integers, and caller mutation during verification. Eight cross-repository tests in organizacia `api/nightly-archive.integration.test.mjs` connect the real source exporters to this adapter with independent held synthetic checkpoints, separate SQLite source/archive databases, and fake R2. They preserve source markers on Git failure, reconcile interrupted archives without repeating source actions, reject deletion resurrection, and keep timeout distinct from later completion. No live Worker/D1/R2 execution or durable scheduling is claimed.
