# Candidate working-memory heads: isolated rehearsal

**Disabled by default. Not deployed. Not an ERP-primary mode. Not connected to an active loader or writer.**

This adapter allows a mutable *candidate* pointer to an existing immutable pilot snapshot. It never edits memory content, imports a new snapshot, executes its text, updates Git, deletes history, touches publishing queues, or changes production bindings. The only permitted scopes are:

- Agents: exactly `diana-helios` and `angela`.
- Names: exactly `MEMORY.md` and `MEMORY_RAW.md`.
- Modes: the existing copied `off` / `shadow` configuration. Missing configuration or a missing agent entry stays off. `primary`, `erp-primary`, aliases and unknown configuration fields fail closed.
- Targets: an already existing, independently hash-verified immutable manifest in the same namespace and agent, with kind `working-memory`, source type `github`, a full lowercase 40-character pinned revision, and exact source key `dasexperten/organizacia:agents/<agent>/<name>`.

Rules, `LEARNING.md`, other filenames, queue snapshots, arbitrary exports and foreign-agent/namespace manifests cannot become heads. A snapshot's words, JSON approval flags or archived state confer no authority. These are archival Git-origin candidate pointers, not ERP-native working-memory replacement writes. Routine Git memory writes are not eliminated by this package. This is not a distillation process, an authorization service, or a source-authenticity verifier. Import provenance still depends on the existing trusted capture verifier.

## Files and local tests

Apply `schema.sql` and then the new `memory-head.schema.sql` **only to a separate local pilot database**. The new schema is not registered as a production migration. The existing snapshot schema/store/capture are unchanged in this stage. The separate Node 24 pilot workflow includes these tests on the exact PR head. Existing production CI and deploy workflows are unchanged. Real-workerd tests remain separately opt-in and local; their passing result is not remote CI or production proof.

Run with Node 24, with the optional network-denying preload:

```sh
node --import ./pilots/operational-storage/no-network.mjs --test \
  pilots/operational-storage/store.test.mjs \
  pilots/operational-storage/capture.test.mjs \
  pilots/operational-storage/memory-head.test.mjs
```

Tests use real Node SQLite, D1-style `prepare().bind().first()/run()` calls, an in-memory fake R2 bucket, and synthetic memory bytes. A race test uses two independent connections to one temporary SQLite file and synchronizes both writers before their INSERT. No remote D1/R2 resources, credentials, real memory or external actions are involved. This is a local correctness rehearsal, not validation of remote Cloudflare latency, operational limits or distributed storage behavior.

## Trusted authorization and dependency boundary

Construct `createMemoryHead({ config, db, store, authorize, now? })` using the separate pilot D1 binding and `createPilotStore` reader for the same namespace/database. The adapter compares the verified reader's manifest against that database before accepting it. Use a primary D1 binding or a sequentially consistent D1 session for the operation's reads and writes; do not mix unrelated replica reads. There is no public route, cookie/session bypass, credential generation or persistent-access provisioning.

`authorize` is mandatory and must be bound to an independently authenticated identity. It receives a frozen object with `namespace`, `agent`, `name`, `operation` and, for mutations, the exact request's `expectedVersion`, `expectedFence`, `requestId`, and target `manifestId` when applicable. It must return exactly `true`. Missing, denied, non-boolean or failing authorization fails closed before storage I/O. Operation values are:

- `read-candidate`
- `advance-head`
- `rollback-head`
- `fence-head`

Only trusted coordinators should receive `fence-head` permission. A callback returning `true` for everything exists **only in synthetic tests**. Production permission and identity rules are unspecified and must not be invented here. Snapshot-store authorization is separately required. A successful head authorization cannot bypass a denied store read.

Direct database write access remains privileged. SQL can enforce metadata, CAS and immutable history but cannot verify R2 bytes. Only a trusted adapter that performs hash verification may hold a mutation binding. Triggers are application-integrity protections, not defenses against an administrator who drops tables/triggers or changes database files.

Advance-versus-rollback permissions distinguish immutable manifest identities, not the meaning of their text. A genuinely new, independently verified Git revision may contain wording identical to an older revision. Source verification and any editorial policy for such a revision remain separate responsibilities; this adapter does not decide whether memory text is semantically newer or approved.

## API

All inputs have exact fields, no extra fields or accessors. Request IDs are 1–128 ASCII letters, digits, `.`, `_`, `:`, `-`, starting with a letter or digit. Use a stable unique request ID scoped to `(namespace, agent, name)` for each logical operation and retain it for retries. Versions and fences are nonnegative JavaScript-safe integers. Version zero/fence zero mean no head exists; the first advance produces version one/fence zero.

```js
const candidate = await heads.readCandidate({ agent: 'angela', name: 'MEMORY.md' });
// null, or { candidateOnly: true, head, manifest, bytes }

const result = await heads.advanceHead({
  agent: 'angela', name: 'MEMORY.md',
  manifestId: previouslyImportedManifestId,
  expectedVersion: candidate?.head.version ?? 0,
  expectedFence: candidate?.head.fence ?? 0,
  requestId: stableOperationId,
});
// { candidateOnly: true, replay: false, transition }
```

`readCandidate` verifies the head metadata, its immediate predecessor, the linked immutable manifest, the exact original bytes and SHA256. It never supplies active system instructions or changes current readers. Returned bytes must continue to be treated as untrusted data. A read is a verified snapshot at the time it is obtained, not a promise the head will remain current afterward. Future consumers must carry its version and fence to their own authorized writes. Do not merge this into an active loader to bypass a separately approved cutover.

`advanceHead` may select only a manifest that this exact namespace/agent/name head has never referenced. Selecting any previously referenced manifest, including the current target under a new request ID, requires `rollbackHead` and its separate `rollback-head` authorization. Both the adapter and SQL trigger enforce this distinction. An exact historical request retry is resolved first and remains an authorized replay, not a new selection. This classification concerns immutable manifest identity, not interpretation of the snapshot's meaning or contents.

`advanceHead` checks the target's integrity again, including on retries. No bytes are uploaded or altered. Different verified contents require an already imported distinct immutable manifest. A failure of head storage is not permission to retry a source action, re-run a distillation or alter Git.

## Atomicity and append-only history

`pilot_working_memory_transitions` is the authoritative append-only log. `pilot_working_memory_heads` is a view selecting the greatest version for each exact scope. The logical pointer changes by one INSERT to the log; there is no separate mutable pointer row to get out of sync with history.

One SQL statement plus a BEFORE INSERT trigger validates the expected version/fence, predecessor, allowed target metadata and action, then commits the new version. This is a real SQLite atomic transaction, compatible with D1's statement execution model. It does not call unsupported `BEGIN`/`COMMIT` through D1 or rely on a JavaScript read-check-write for CAS. Two different target updates racing from the same version have exactly one winner. The other receives a visible conflict and must re-read and decide whether its work is still valid. It must not silently rebase or overwrite the winner.

Each transition preserves target manifest ID and SHA256, prior manifest ID, previous/current version and fence, action, request ID and commit timestamp. UPDATE and DELETE abort. INSERT OR REPLACE cannot erase an existing version or request identity even with recursive triggers disabled. Exact request retries return the original transition. Reusing a request ID with different operation, target, expected version or expected fence fails.

The latest row and its immediate chain linkage are checked on read; this is not a cryptographically signed audit chain or a full historical database corruption scrub. No automatic garbage collection, head reset, version reuse or request-ID expiry exists.

## Ambiguous outcomes and failures

If D1 commits but its response or the subsequent read is lost, preserve the request ID and all exact request fields. Retry the same call. A successful prior transition is returned with `replay: true`, its original version and timestamp, without issuing another write. This also works after newer transitions have committed. If an identical concurrent call commits between the initial request lookup and later head/target checks, those conflict checks re-read the request identity and return the same verified transition; they never rebase a stale operation. The replay identifies that historical operation; it does not mean its target is still the latest head.

Missing/corrupt R2 data, hash disagreement, unknown/foreign manifests, denied authorization, unavailable storage and SQL failures surface as errors. No silent fallback to Git or another agent, no in-place snapshot repair, and no speculative success. An exact retry whose historical target is now missing/corrupt fails integrity verification without advancing a version. Treat an error after a write as potentially committed until the same request is reconciled; do not invent a new request ID simply to retry.

R2 and D1 do not share a transaction. The adapter verifies the target immediately before D1 insertion; if an administrator deletes/corrupts the object afterward, later candidate reads fail closed. This package cannot guarantee perpetual blob availability. Retention protections and an operational repair policy are prerequisites to any later real deployment. A verified transition to another intact snapshot can replace a broken current candidate; the broken historical record is retained, never rewritten.

## Fence and rollback rehearsal

Fences are monotonic epochs, not leases, passwords, user identities or arbitrary caller-selected tokens. Every mutation supplies the expected current epoch. Ordinary advances and rollbacks keep it unchanged. A separately authorized `fenceHead` call advances the version **and** epoch by exactly one, keeping the same verified target:

```js
await heads.fenceHead({
  agent: 'angela', name: 'MEMORY.md',
  expectedVersion: current.head.version, expectedFence: current.head.fence,
  requestId: stableFenceOperationId,
});
```

Fencing requires an initialized head and an intact current target. A writer with an old epoch is rejected even if it has learned the current version. An authorized writer that reads the new epoch can continue, so fencing alone does not revoke a principal's permissions. A real coordinator must also stop/revoke obsolete writer authorization when needed. These fences protect this pilot head only, not Git, queues, publishers or other external systems.

To rehearse rollback:

1. Keep all active loaders/writers untouched and production flags off.
2. Stop the obsolete rehearsal writer and, when appropriate, perform a separately authorized fence transition; re-read the resulting version/epoch.
3. Select a manifest previously referenced by this exact head. Re-read its original bytes and verify integrity through the adapter.
4. Call `rollbackHead` with the same fields as `advanceHead`, that prior manifest ID, the **current** expected version/fence and a new stable request ID.
5. Verify `readCandidate` returns the intended original bytes. Rollback adds a new version, retains the current epoch, and leaves all intervening snapshots/history intact.

A rollback cannot select an unreferenced manifest, reset the fence/version, remove a row, or delete R2 data. If fencing is blocked by a corrupt current target, do not reset history or skip verification. Stop/deny the obsolete writer through the separately managed authorization boundary, append a verified recovery/rollback transition with CAS, and then fence the intact target if appropriate.

Turning the pilot off simply disables its API without changing any data. It does not roll back a live cutover. Remote service provisioning, production auth, all-loader/all-writer integration, source-of-truth changes and any real cutover/rollback remain separate reviewed work.
