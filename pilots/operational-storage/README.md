# Operational storage: isolated archive pilot

**Not deployed. Not connected to production. No current publisher, loader, export or cron changes.**

This package rehearses the storage boundary for Diana and Angela. GitHub remains the source for code and system rules. A future cutover can keep operational records in ERP D1 and exact payload/evidence bytes in private R2, but this pilot cannot perform that cutover or stop current commits by itself.

## Included

- `schema.sql`: separate pilot manifest table, never added to production migrations.
- `store.mjs`: dependency-injected D1/R2 archive writer and integrity-checked reader.
- `config.example.json`: independent exact-agent flags, both off. Only `off` and `shadow` exist. No primary mode.
- `store.test.mjs`: Node SQLite plus in-memory R2 tests. No Cloudflare account or credentials required.
- `capture.mjs`: observer-side writer adapters for Git files, allowed D1 records and evidence. No source write callbacks or source-state updates.
- `capture.test.mjs`: byte/ID/status preservation and existing reader-contract integration with synthetic data.
- `no-network.mjs`: Node-only optional test preload that blocks unmocked network traffic.

Run locally with Node 24: `node --test pilots/operational-storage/store.test.mjs`.

The suite deliberately uses real SQLite through Node 24's `node:sqlite`. Existing Node 20 deployment CI does not cover it. A separate draft-PR workflow runs the pilot under Node 24 with read-only repository permission and no Cloudflare credentials or deployment step. Its optional Diana cross-repository checks remain local-only and are explicitly skipped in CI. Production CI Node versions and deploy workflows remain unchanged.

The corresponding organizacia `pilots/operational-storage/` contains a metadata-only import planner and the reader/writer dependency inventory. There is no automatic import into any live service.

Its context reader uses canonical Git source keys `dasexperten/organizacia:${path}`, matching the capture writer. The optional cross-repository integration test executes capture → real local SQLite/fake R2 → shadow context parity. System rules and active context stay on the pinned Git source. These isolated adapters are not wired into current Worker or desktop loaders.

## Writer adapter and rehearsal

`createOperationalCapture({config,store,sourceVerifier})` observes **already obtained source snapshots**. It does not execute the original action, commit GitHub files, query source databases, send messages, publish, or update export/distillation markers. Flags use the same exact-agent off/shadow contract. An off agent returns an explicit skipped result and does not access storage.

The trusted `sourceVerifier` callback must independently verify the source descriptor against reviewed pinned Git metadata or a consistent authorized D1/R2 export. A source's `approved:true` value cannot satisfy it. Tests use only synthetic fixtures. This callback is not a production source-verification service. Store-level authorization is independently required.

- `captureGithubFile`: checks exact agent path, permitted working-memory/artifact/outbox type, full commit and Git blob IDs, Git SHA-1 object hash, then separate SHA256. Mixed LEARNING, rules, code, sensitive-looking paths and unknown formats fail for review. Original pinned URL is retained. Outboxes always remain queue snapshots with no activation.
- `captureD1Row`: accepts only `org_task_runs`, `agent_chat_messages`, `ugc_creators` (Diana), and `angela_article_queue` (Angela). It preserves opaque string creator IDs and integer organization IDs, validates agent scope/source shape, and retains exact original JSON bytes, unknown fields, timestamps, status, approval payload, version and markers. The checkpoint must identify the consistent export. No source table is modified.
- `captureEvidence`: preserves an explicitly verified R2 or local-export source key/version and exact bytes. The output says bytes verified, not outreach verified. Existing offer/delivery object keys are not overwritten.

If source snapshot capture fails after a source action succeeded, retain that action's actual outcome and surface an independent pending archive error. **Never retry the external action to repair storage.** A later source read/checksum and idempotent archive retry may repair the archive only. Do not mark `exported_at` or `distilled_at` to pretend a GitHub export happened.

Run capture tests with Node 24: `node --test pilots/operational-storage/capture.test.mjs`. An optional `DIANA_RUNNER=/path/to/organizacia/jobs/diana-instagram-scouting/runner.py` enables a local Python receipt-count parity test. The fixture also imports the existing ERP queue's read-only status contract with no publisher configured, preserving initializedAt, seen, CAS version, unknown/publishing outcomes and payloads. No production queue is initialized or ticked.

## Contract

Construct `createPilotStore` with a copied config, **separate pilot** D1 `db`, **private pilot** R2 `bucket`, and a trusted `authorize({agent,operation,namespace})` callback. It must be bound to an authenticated identity and return exactly `true` only for allowed agent + read/import operations. Missing or failed authorization denies access. Never use `() => true` outside synthetic fixtures, request-supplied approval flags, or global auth observe mode. A production authorization route is deliberately absent and remains a cutover prerequisite.

`importSnapshot(descriptor, bytes)` requires `agent`, `kind`, `contentType`, `expectedSha256`, and `source: {type,key,revision,originalUrl?}`. Supported kinds: working-memory, communication, report, evidence, queue-snapshot, approval-snapshot, operational-record. Sources: github, d1, r2, local-export. Content is copied without parsing or rewriting. Maximum payload is 32 MiB; larger evidence needs a separately reviewed streaming/chunked implementation.

The 32 MiB guard is a code bound, not a verified Worker capacity claim: hashing and readback hold multiple copies. Use small synthetic fixtures for rehearsal. Cloudflare memory/runtime limits and realistic evidence sizes must be load-tested before any remote deployment.

Source key and revision must identify an immutable audited source. For GitHub, use repository + path as key, pinned commit as revision, and the original pinned URL. Verify downloaded bytes against the Git blob SHA before computing SHA256. A Git blob SHA is not a SHA256. D1/R2 snapshots require a separately captured version/checkpoint and authorization to read their source; an arbitrary caller string is not source authenticity evidence.

The manifest ID hashes agent + source type + key + revision and is rechecked on read. R2 keys include namespace + agent + SHA256. D1 insertion happens only after readback and hash verification. Exact retries return the same manifest. Different bytes or metadata for the same source revision fail rather than overwrite. SQL triggers reject manifest UPDATE/DELETE; no latest pointer or deletion API is provided. R2/D1 errors are visible and never silently fall back to GitHub. A failed D1 write may leave an unreferenced R2 blob; retry verifies and reuses it. Do not delete unreferenced blobs automatically.

A BEFORE INSERT guard also ignores duplicate identities before SQLite REPLACE can delete the existing row; API post-read comparison still rejects conflicting payloads. These are application-integrity guards, not protection against an administrator who can drop tables/triggers or alter storage directly.

`readSnapshot(agent,id)` rechecks access and bytes. Storage uses application/octet-stream metadata. A future HTTP evidence route must authenticate every read, enforce agent scope, use safe attachment headers, and avoid executing archived HTML/SVG content. No public bucket or public evidence URL is created by this package.

`archive_only=1` is a SQL constraint. `integrity_state=bytes-verified` describes only byte integrity. It is **not** Diana's external-action `verified` flag, proof of outreach, editorial approval, authorization to post, or a delivery receipt. Unknown/scheduled/publishing statuses and approval/source objects are preserved inside exact original bytes and never activated. Imported queue copies are not the active queue. The library has no send, publish, tick, approve, initialize, reconcile or dispatch method.

## Deployment boundary

No Wrangler config, Worker entrypoint, cron, binding ID, credential, existing source import, deploy command or production migration registration is included. `pilots/` is outside `workers/erp-*` discovery and deployed API source. Do not alias pilot resources to production; the library cannot prove that a caller supplied a separate remote database/bucket. Provisioning or wiring real services needs a separate reviewed step and permission.

Existing `angela_article_queue`, `org_task_runs.exported_at`, `Social/angela/offers/*` locks, original GitHub paths, and permissions stay untouched. Production cutover requires the full organizacia dependency inventory, an authenticated operational API, trusted revision-bound editorial approvals, all-reader/all-writer migration, current baseline and delivery-state preservation, live reconciliation, rollback rehearsal, and notification before switching.

## Rollback of this preparation

Do not import this module from a production entrypoint. Keep both flags off. Historical data stays where it is. If a later isolated rehearsal is stopped, retain its manifest and objects for audit; there is no deletion script. After any future live cutover, turning a flag off alone is not a safe rollback: first reconcile records and external outcomes and preserve delivery locks before any old writer is re-enabled.
