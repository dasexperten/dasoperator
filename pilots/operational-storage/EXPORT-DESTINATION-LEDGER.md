# Candidate archive destination receipts (disabled)

These four new files are a local, isolated candidate, not an applied migration or an active exporter/dashboard change. No bindings, source import, grants, deployment, publisher, queue consumer, Git writes, or ERP-primary activation are included. Existing `store.mjs` and `capture.mjs` are used unchanged. The private-capability component was not inspected or used.

## Boundary and integration gates

`createExportDestinationLedger` accepts the existing pilot configuration: missing configuration and omitted agents are off; only explicit shadow mode in a pilot namespace for exact `angela` and `diana-helios` is accepted. It exposes only `recordReceipt` and read-only `projectCurrent`. A trusted, externally authenticated authorization adapter is mandatory for each operation. It must not interpret caller `approved`/`verified` data as authorization. Application code owns this trusted boundary; injecting an arbitrary allow-all adapter or counterfeit store is not a security boundary. There is no HTTP entrypoint.

The receipt request includes exactly agent, table, positive integer sourceRowId, sourceRevision, manifestId, expectedSha256. Only `org_task_runs` and `agent_chat_messages` are allowed. Archive destination is fixed to pilot R2, with the independently validated existing manifest/object address. No receipt input can set exported_at or distilled_at, and there is no source mutation callback.

Recording independently calls the existing store's `readSnapshot`, which reads the manifest and actual R2 bytes and verifies their hash. The ledger additionally verifies namespace, exact agent/table/row identity, checkpoint revision, content type, kind, byte length/hash, archive-only state and destination key. Receipt identity hashes namespace, agent, table, row ID and source revision. A receipt cannot be repurposed for changed immutable fields. Append-only SQL triggers prevent updates/deletes; a before-insert guard against OR REPLACE bypass even with recursive triggers off, unique keys plus insert/readback support concurrency and exact replay. Receipt time is descriptive, not ordering or freshness authority. A lost insert response is uncertain: re-submit the same immutable request after restoring access; verified existing matching receipt returns replay. Do not compensate by deleting or changing source rows.

Production auth, binding separation, schema application review, trusted current-source reader implementation, source-capture provenance/checkpoint review, and exporter wiring remain explicit unimplemented gates. Nothing in this module establishes those gates or declares cutover ready. An archive receipt is not a delivery, user approval, executed callback, or operational instruction.

## Exact fingerprint contract: operational-json-v1

Original archived bytes are never rewritten. SHA-256 on exact bytes remains the archive identity. A separate comparison fingerprint is SHA-256 over the UTF-8 encoding of this deterministic JSON representation:

- Parse valid UTF-8 JSON object with a maximum 32 MiB input and 100 nested levels. Reject duplicate object keys at every level, malformed JSON/UTF-8 and invalid root/identity. Do not silently lose duplicate or unknown fields.
- Recursively sort every object's decoded keys by JavaScript default string sort (UTF-16 code unit order). Encode decoded keys and string values using JSON.stringify. Preserve array order. Preserve original numeric token spelling exactly, including exponent/decimal forms, to avoid loss from IEEE-754 coercion. Boolean and null tokens remain exact. JSON formatting whitespace and equivalent string escape spelling do not change comparison.
- Remove exactly one **top-level** destination bookkeeping field: `exported_at` for task runs; `distilled_at` for chat messages. Presence/absence/value of that field is separately recorded in the immutable receipt and current projection. Do not exclude other timestamps, IDs, status, content, meta, joined title, nested markers, unknown fields, or future columns. In particular, unknown updated_at changes are mismatches even if a future writer calls them bookkeeping.
- Hash all remaining fields, including unknown fields. Different numeric spellings conservatively mismatch, even when mathematically equal. A changed row reused under the same integer ID mismatches if any included field differs. Identical content under a reused ID cannot establish business-event identity; source checkpoint and receipt identity remain separately visible and no delivery/operation freshness is claimed.

Task status is recorded exactly; chat status is explicitly absent unless the observed payload actually contains it. Original marker/status observations encode presence separately from JSON null. Empty-string markers are reported as raw presence, not verified export success or exporter eligibility. In particular, the real chat exporter can still select an empty distilled_at.

## What current matching means

`projectCurrent` uses a separately supplied trusted `readCurrentSource` callback, authenticated/scoped by the ledger and returning raw JSON bytes or null. It cannot accept a caller current row or a verified boolean. It reads **all** stored receipts within strict fail-closed bounds (at most 32 receipts and 32 MiB of archived bytes; excess throws rather than returning partial freshness) for that exact source scope, independently re-verifies each archive and receipt, and compares included fields with the current observation. Any failed archive verification fails closed, including for historical receipts. It never selects a supposedly latest receipt by arbitrary checkpoint order or wall-clock timestamp.

A current-content match means equality of all fields in the independently observed current payload under the contract, not proof of every database column or a transactionally consistent backup. The actual task exporter selects `r.*` plus joined task title; chat selects only id, agent_slug, role, content, channel, meta, created_at, omitting distilled_at and possibly other columns. A complete returned export observation is not a complete database row. A current reader should retain all fields it observes; newly observed columns mismatch an older incomplete capture. Do not manufacture equality by allowlisting only old fields. Unknown completeness must not become a full-row claim. Grouped exporter snapshots require a separately reviewed per-row capture adapter before they can feed this ledger; no implicit group-to-row conversion exists here.

Projection reports legacy Git-marker presence independently of archive receipt state and explicitly says deliveryVerified false, archiveCompleteness captured-export-observation-only, consistentDatabaseBackupVerified false, legacyDashboardCountsUnchanged true, and cutoverReady false. It is a point-in-time read, not an atomic guarantee against a source change immediately afterward. No source fence or cross-service transaction is claimed. Historical receipts remain visible when status/content/unknown fields changed or the source disappeared. These reports must never clear legacy dashboard missed counts.

## Policy/data preservation

Task/chat content and meta are opaque. Human-set stages, manual-review markers, pre-agreement scouting notes, Telegram message IDs, choices and callback receipts remain unchanged in original bytes and participate in the fingerprint. Tests model them only as task/chat content/meta, not as invented ERP columns. No UGC card creation, stage transitions, active queue processing, rule changes, callback actions or promotion of archived correspondence to live-source authority exists.

## Local verification

Run from the repository root:

`node --import ./pilots/operational-storage/no-network.mjs --test ./pilots/operational-storage/export-destination-ledger.test.mjs`

Tests use real in-memory Node SQLite, actual existing store/capture, fake R2 and the network guard. They cover off/auth, scope/digest verification, original bytes, unknown/policy fields, replay/concurrency, old revisions and reused IDs, append-only triggers, D1 lost response, pre-insert failure, R2 unavailable/corrupt, marker-only changes versus status/content/unknown drift, absent marker/status, duplicate JSON keys, and source-reader requirements. Fixture allow-all auth/source verification is test-only, not a usable production grant. Workerd/D1 service-specific behavior and live integration have not been tested.
