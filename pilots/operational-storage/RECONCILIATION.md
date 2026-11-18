# Read-only archive reconciliation preparation

**Local-only, disabled by default, not deployed or connected to production. This is a comparison of a pinned source snapshot with an isolated archive, not a migration executor or cutover gate.**

`reconciliation.mjs` checks already obtained, authorized source snapshots against existing immutable `pilot_operational_manifests` and private pilot blobs. It has exactly one method, `reconcile`. It performs only one archive-manifest SELECT plus blob GETs. There is no source reader/writer, import, bucket PUT, SQL mutation, head mutation, retry queue, publisher, external action, deletion, marker reset, active loader, route or deploy entrypoint. No new schema is required. Existing store, capture, memory-head, router, source tables, workflows and production configuration stay unchanged.

The scope is exactly `diana-helios` and `angela`, with the existing `off` / `shadow` configuration contract. Missing configuration/agent entries remain off. All-off returns `skipped: 'pilot_disabled'` before inspecting inputs, hashing, authorization or ERP reads. Mixed mode reads only enabled, explicitly inventoried and authorized scopes. A configuration whose enabled agents have no inventoried scope returns `no_enabled_inventory_scopes`, not vacuous parity. No primary mode exists.

## What a result means

A `matched` archive result means that, for the listed source checkpoint/time and independently pinned inventory:

- Every expected source identity is present exactly once, with the pinned revision, byte length and SHA-256.
- Every expected archive manifest identity is derived from exactly `[agent, sourceType, sourceKey, sourceRevision]` and matches the required immutable manifest metadata.
- Current-revision manifest IDs/counts agree exactly within the approved scopes. Additional current-revision IDs block aggregate parity even if every expected ID matches.
- Each expected object exists and its observed bytes match the pinned size/hash. Identical record counts without matching IDs/revisions/bytes never pass.

Every report says `readOnly: true` and **`cutoverReady: false`**, including perfect equality and a verified empty scope. It also identifies the inventory SHA-256, namespace, source checkpoint and source `asOf`. It does not establish source authenticity independently of the trusted provenance input, production freshness, permissions, completeness outside the selected inventory, editorial approval, action/delivery success or cutover readiness.

Source snapshot state and archive state are separate. `source.actionOutcomes` and `source.legacyExportMarkers` remain `not_assessed`. The adapter does not parse source record bodies to infer outcomes or rewrite their fields. Queue statuses `unknown`, `publishing`, `scheduled`, approval payloads, receipt notes, IDs, versions, baselines, delivery locks, `exported_at` and `distilled_at` stay opaque bytes. Report objects omit payload bytes and raw backend/auth exceptions.

A source record missing from the pinned checkpoint blocks archive comparison; it is not reported as a missing archive record. A later creator cleanup, including the independent UGC cleanup/import-policy changes on ERP main, is not permission to restore an old archived creator. Comparing an old verified snapshot never declares that creator current. Determine the intended current source policy and obtain a new independently verified snapshot separately. This adapter produces no resurrection, overwrite, cleanup or replay plan.

## Independently verified inventory and provenance

Construct the adapter in trusted local code:

```js
const reconciler = createOperationalReconciliation({
  config: {
    namespace: 'pilot-reconciliation',
    agents: { angela: 'shadow', 'diana-helios': 'off' },
  },
  trustedProvenance: {
    inventorySha256: independentlyVerifiedInventoryDigest,
    namespace: 'pilot-reconciliation',
    checkpoint: independentlyVerifiedExportCheckpoint,
    asOf: independentlyVerifiedSnapshotTime,
  },
  db: readOnlyPilotDatabase,
  bucket: readOnlyPrivatePilotBucket,
  authorize: trustedArchiveReadAuthorization,
});

const report = await reconciler.reconcile({ inventoryBytes, sourceSnapshot });
```

`trustedProvenance` is a **separately verified, immutable setup input**, not something to calculate from whatever request JSON, capture result or source payload is under examination. The inventory digest pins its exact UTF-8 JSON bytes, including whitespace. Obtain that digest, namespace, checkpoint and time from the reviewed source inventory/export provenance before constructing this instance. The adapter copies this input and configuration. A later caller mutation cannot change the pin or enable a scope.

For real source preparation, an authorized trusted process must establish that:

1. The full scoped source inventory was obtained consistently, not assembled from unrelated live reads or a partial page. Explicit expected counts include the entire reviewed scope, including a verified zero count.
2. Git records come from independently verified pinned commits and Git blobs. D1 records come from the specified consistent export checkpoint. R2/local evidence has an independently verified immutable version and exact key.
3. A multi-source inventory has a reviewed coherent checkpoint/cutoff contract. Merely labeling unrelated exports with the same string does not make them consistent.
4. Inventory generation did not silently omit records, reinterpret outcome fields or use the destination archive to decide what was expected. Any pending-capture classification came from the reviewed archive backlog, not an arbitrary payload flag.
5. The bytes/metadata/digest and source checkpoint/time were independently checked before they became trusted setup. A matching hash alone is not source authenticity or authorization.

There is no production inventory/provenance service in this package. Tests use independently constructed synthetic inventories and fixture-only authorization. Never expose a route that accepts `trustedProvenance`, `authorize`, `approved: true` or adapter bindings from request content. Unknown metadata fields, inherited/accessor/hidden/symbol authority fields, unsupported agents/modes and missing trusted provenance fail closed.

### Inventory version 1

`inventoryBytes` is a Uint8Array holding UTF-8 JSON with these exact top-level fields:

```text
{
  version: 1,
  namespace: string,
  checkpoint: string,
  asOf: canonical UTC ISO time, such as 2026-11-05T08:00:00.000Z,
  scopes: [...],
  records: [...]
}
```

Each scope has exactly:

```text
{ agent, sourceType, sourcePrefix, revision, expectedCount }
```

- `sourcePrefix` is a literal, case-sensitive prefix, never a SQL `LIKE` expression. Percent signs, underscores and Unicode cannot expand it.
- Git prefixes are exactly `dasexperten/organizacia:agents/<agent>/` or its `data/` subtree; Angela additionally supports `social-outbox/` and `offer-outbox/`. Full lowercase 40-character commit revisions are required. Per-record paths/kinds use the existing pure capture classifier. System/identity/rule/learning/code or sensitive-looking paths fail that policy.
- D1 prefixes are exactly `organization-d1/org_task_runs/`, `organization-d1/agent_chat_messages/`, `organization-d1/angela_article_queue/` for Angela, or `erp-d1/ugc_creators/` for Diana. Task/chat scopes work for either pilot agent. Row IDs must be canonical positive safe integers; Angela's queue ID must be `1`. Creator IDs remain opaque strings with canonical URI encoding.
- R2 and local-export evidence use explicitly reviewed literal prefixes, immutable revisions and exact source keys. They can only have kind `evidence`. A prefix is a read scope, not permission to publish or alter source objects.
- Scopes for the same agent/source type cannot overlap, even when revisions differ. One source record belongs to exactly one scope. Each scope count must equal its listed record count.

Each record has exactly:

```text
{
  agent, sourceType, sourceKey, sourceRevision,
  manifestId, kind, contentType, sha256, contentBytes,
  originalUrl, archiveExpectation
}
```

- Manifest IDs use the existing store's SHA-256 of the JSON array `[agent, sourceType, sourceKey, sourceRevision]`. Both hashes are lowercase 64-character hex strings.
- Kind, content type, original URL, byte length/hash and archive identity are pinned, not inferred from destination state. `originalUrl` is an HTTPS URL without credentials, or `null`; Git URLs must pin the exact repository/commit/path with the capture encoder.
- `archiveExpectation` is either `required` or `pending`. It classifies an absent manifest only. A present but missing/corrupt blob is never excused as pending. A present exact archive can match either expectation. This reviewed backlog metadata grants no read/write/action authority.
- D1 bodies remain opaque; the allowed table/agent/key/kind relationship is checked against metadata. Establishing that the payload belongs to that identity is the independent source verifier's job; this adapter compares its pinned hash. It does not parse and reserialize row JSON.

Bounds are 16 nonoverlapping scopes, 10,000 inventory/source/archive rows, 32 MiB per payload/inventory, and 64 MiB aggregate source bytes. The single query uses at most 65 parameters. These are fail-closed implementation bounds, not verified remote capacity/performance claims. There is no partial-report success, automatic pagination or streaming support; larger inventories require separate reviewed preparation.

### Source snapshot

`sourceSnapshot` has exactly:

```text
{
  checkpoint,
  asOf,
  records: [{ agent, sourceType, sourceKey, sourceRevision, bytes: Uint8Array }]
}
```

Checkpoint and canonical timestamp must match both trusted provenance and inventory exactly. All supplied source identities must belong to the pinned inventory, and duplicates fail. Every enabled inventory identity must occur with exact bytes; disabled records may be omitted and are not hashed/read from ERP. Supplied disabled-source metadata must still be well formed and must not introduce extra or duplicate identities. Record order is irrelevant. All caller-owned bytes are copied before the first asynchronous operation.

A timestamp mismatch, checkpoint mismatch, missing record, extra identity, revision drift or byte mismatch sets source `blocked` and leaves the archive `not_checked`, with **zero archive authorization/database/blob calls**. Individually equal records become `unverified` if the overall snapshot contract fails. Malformed input, inventory digest/schema/provenance failures and inconsistent expected counts throw stable errors before archive reads.

`asOf` identifies the source snapshot contract, not the local reconciliation start time. The report makes no recency claim. An archive import may predate a later observation of the same immutable source revision; `imported_at` is validated as a timestamp but is not used to invent revision ordering, action outcome or source freshness.

## Archive access, counts and failure states

The independently authenticated `authorize` callback receives a frozen object containing:

```text
{ namespace, agent, sourceType, sourcePrefix, revision, operation: 'reconcile-read' }
```

It must return exactly `true`. Missing, denied, non-boolean or throwing authorization marks that scope `unavailable` before any storage access for it. Bind this to the current read identity and approved exact scopes. This authority is independent of the source provenance pin. Empty scopes are also authorized before checking that no destination records exist. `reconcile-read` includes listing historical manifest metadata in the specified prefix; it does not authorize historical blob reads.

`db` needs only D1-style `prepare().bind().all()`, returning `{success: true, results: [...]}` for a **complete** result. Use the separate local pilot database or an already authorized immutable local export. Never alias it to production. After authorization, all authorized scopes share **one SELECT**, so the manifest cohort/counts come from one SQLite/D1 statement snapshot. Namespace, exact agent/type and literal prefix are bound parameters. No disabled or denied scope appears in this query. Untrusted, partial or truncated list adapters cannot establish completeness and must not be supplied.

Manifests are checked for exact scope/ID, source revision, immutable metadata, archive-only flag, integrity label, expected object key and duplicate identities. A foreign/malformed result, duplicate ID or damaged metadata is a conflict. The adapter never follows an arbitrary object key from a damaged manifest. Historical revisions are counted separately, retained, and never substituted for the required revision. Their blobs are not read or claimed to be verified. An expected record absent at the pinned revision remains missing/pending even if a historical revision exists.

Archive record statuses are:

- `matched`: exact manifest fields and observed blob bytes agree with the pin.
- `pending`: manifest is absent and the pinned inventory explicitly records a pending capture.
- `missing`: a required manifest or an expected blob is absent.
- `conflicting`: manifest metadata, duplicate/list scope, size or hash disagrees.
- `unavailable`: authorization, manifest read, bucket read or body read could not complete. Backend exceptions are sanitized, not returned verbatim.
- `not_checked`: source/provenance was not established, or the whole pilot was off.

Counts keep expected, matched, pending, missing, conflicting, unavailable, unexpected-current-revision, historical and skipped records separate. Aggregate status is `blocked` for an authorization/read/integrity/count conflict, `incomplete` for missing/pending only, and `matched` only when the whole observed cohort agrees. Expected records can have individually matched bytes while an unexpected destination identity still blocks aggregate parity.

D1 and R2 do not share an atomic snapshot. Blob GETs verify bytes as observed after the single manifest listing. An administrator could damage/delete data after a successful read, or new manifests could arrive after the statement snapshot. This package does not claim perpetual availability or a current global cutover point. A real deployment would require a separately approved frozen/reconciled cohort and retention/access controls. Trusted adapters need bounded reads; this package implements no deadlines, cancellation, retry service or fallback.

## Existing dashboard/export semantics

The source dashboard/runtime invariant is:

```sql
status = 'missed' AND exported_at IS NULL
```

It exists in `organizacia/api/routes-agents.mjs` and `organizacia/fleet/shared/runtime.mjs`. Merely archiving a missed task must not remove it from that count. `exported_at` denotes the existing source export contract, not R2/D1 archival success. The same rule applies to preserving `distilled_at` and unknown future marker fields.

Tests populate real synthetic source tables, archive the exact row bytes through the existing capture/store, reconcile them, and compare the existing SQL predicate before and after. They also evaluate that predicate on archived-byte projections, preserving `NULL` versus an empty string versus a real export timestamp. Production readers/markers are untouched. There is no code here to suppress missed tasks or pretend a Git export/distillation occurred.

## Local tests and use of findings

With Node 24, from the dasoperator checkout:

```sh
node --import ./pilots/operational-storage/no-network.mjs --test \
  pilots/operational-storage/reconciliation.test.mjs
```

The suite uses actual Node SQLite, the existing capture/store, an in-memory fake R2 bucket and synthetic data. It covers scoped counts/IDs/hashes/revisions, one-statement manifest consistency, all-off/mixed isolation, pinned provenance/time/checkpoints, missing/extra/duplicate source records, source mutation after call, denied reads, missing/partial/corrupt blobs, sanitized outage states, historical revisions, orphan uploads, idempotent replay, exact queue/approval bytes and missed/distilled-marker semantics. No credentials, remote services, source actions or Git writes are used.

For aggregate regression checks, add `store.test.mjs`, `capture.test.mjs`, `memory-head.test.mjs` to that local command. Cross-repository or workerd tests remain separate opt-in checks documented in the existing pilot files. This new suite is not registered in CI or a production workflow by this change.

Treat findings as review evidence:

1. Fix the provenance/snapshot selection before investigating an archive discrepancy when source is blocked. Do not repeat the original action to recover evidence.
2. For missing/pending archives, independently determine whether an archive-only capture of the exact authorized revision is appropriate. This module does not perform it and does not authorize it.
3. For an outage or uncertain archive observation, retain the original action outcomes and source markers. A later identical read-only comparison can establish availability; it never retries an external action.
4. For conflicts or unexpected records, stop claiming cohort parity and review the pin/scopes/storage integrity. Never rewrite/drop immutable records to make a count match.
5. Keep production off. Full dependency coverage, authenticated operational APIs, trusted revision-bound editorial approvals, current baseline/delivery-state preservation, all-reader/all-writer migration, rollback rehearsal and explicit cutover authority remain independent prerequisites. Parity alone satisfies none of those decisions.
