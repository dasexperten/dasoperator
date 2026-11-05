# Opt-in Cloudflare runtime rehearsal

This is an isolated synthetic test harness, not a Worker entrypoint for deployment.
It executes the unchanged `store.mjs`, `capture.mjs` and `memory-head.mjs` inside official Cloudflare
workerd through Miniflare, using actual local D1 and R2 APIs. It creates no remote
Cloudflare resources, bindings, routes or deployments and reads no source records.

## Run

From the repository root with Node 24 (the validated version):

```sh
npm ci --prefix pilots/operational-storage/miniflare-runtime
npm test --prefix pilots/operational-storage/miniflare-runtime
```

The install needs npm registry access and downloads the official local runtime.
The test run needs no internet, account, login, token or Cloudflare credentials.
Only this directory has a package/lockfile; the repository's existing workspaces,
production dependencies, deploy configuration and default test CI are unchanged.
The package lock pins Miniflare **4.20260730.0** and workerd **1.20260730.1**, with
registry.npmjs.org source URLs and integrity hashes. Compatibility date is
`2026-07-30`.

Running `node --test pilots/operational-storage/miniflare.test.mjs` directly
without opting in skips the runtime suite and does not load the package. Existing
Node SQLite/fake-R2 unit checks remain independently runnable.

## Isolation

- The runner supplies a scrubbed child environment, not the caller's provider
  credentials, Cloudflare configuration or source paths.
- `cf: false` and `CLOUDFLARE_CF_FETCH_ENABLED=false` disable Miniflare's default
  `Request.cf` sample-metadata fetch. This is required for offline execution.
- The Node guard restricts reviewed `net.Socket` connection paths to loopback
  hosts. The Miniflare listener binds 127.0.0.1 on an ephemeral port. The Worker
  `outboundService` rejects fetch, including the intentional negative test.
  These are test safeguards, not an OS firewall or a sandbox against hostile
  dependencies or alternate transports. No alternate-transport egress was found
  in the reviewed harness.
- Local D1/R2 persistence is disabled and Miniflare is disposed after the suite.
- No Wrangler, remote-proxy binding, provider SDK, live account ID, production
  migration, real approval or source dataset is used.
- Fixture authorization and verification deliberately approve synthetic cases.
  They are test callbacks, not production authentication or source verification.
- Do not deploy `worker.mjs`. Its request-controlled operations are exclusively
  a local test driver and intentionally are not a public or authenticated API.

## Runtime coverage

1. Applying all five schema statements twice using actual D1 `batch` and `prepare`,
   preserving multiline trigger bodies. UPDATE/DELETE abort, both REPLACE identity
   conflicts preserve the original, and RAISE(IGNORE) reports success with zero
   changes. The archive-only CHECK constraint rejects active rows.
2. R2 SHA256 hexadecimal checksum acceptance and rejection of a bad checksum,
   with no object stored on mismatch.
3. Exact binary, empty and non-ASCII bytes; object metadata and checksum readback.
4. Concurrent identical imports, replay, conflicting metadata/bytes, concurrent
   conflicting imports, immutable history and different source revisions.
5. Existing corrupt blobs, corruption after import, missing blobs and repair by
   exact archive replay without changing manifest history or repeating actions.
6. Disabled/missing settings, missing/denied/invalid authorization, agent isolation
   and separate content-addressed keys for Diana and Angela.
7. Git blob SHA1 plus SHA256, required independent source verification and exact
   pinned provenance inside actual workerd.
8. Queue version, baseline, unknown/publishing outcomes, approvals, opaque payloads
   and export/distillation markers remain inert archived bytes. No source tables
   or publisher APIs are created and the store/capture calls attempt no egress.
9. Candidate-head schema/view and multiline SQL guards run on actual D1. Direct
   UPDATE/DELETE abort; duplicate version/request identity REPLACE is ignored with
   zero changes. A test barrier forces both racing requests to reach native INSERT
   before either commits, proving one CAS winner and one exact replay.
10. Lost response after native D1 commit reconciles the original request after a
    newer version. An injected SQL AFTER INSERT abort leaves neither head nor
    history and the same request can retry. Faults only surround the test binding;
    no adapter implementation is changed or fake D1/R2 engine substituted.
11. Fencing, stale epochs, append-only rollback, historical replay, missing rollback
    bytes, four independent agent/name scopes, unknown/wrong targets, and separate
    head/store authorization are verified inside workerd.
12. An advance-only actor cannot restore a historical or current target by calling
    advance again. Both the adapter and direct D1 guard reject that bypass; exact
    prior request replay still works and restoring history requires rollback auth.
13. Damaged current blobs block candidate reads/replays. A verified new target can
    recover the candidate and be fenced without repairing or erasing history.
    Hostile-looking text, approval fields and unknown/publishing state stay inert,
    and synthetic delivery-lock objects remain unchanged.
14. Native D1 stale-read schedules pause after a negative request lookup or empty
    current-head read, commit an identical concurrent call, then release. Advances,
    fences and rollbacks reconcile as exact replay with no extra INSERT. Reused
    request IDs with changed targets and corrupted historical bytes still fail.
15. The Node egress guard and Worker outbound interception are tested explicitly.

Schema loading here splits only at the two reviewed schemas' top-level CREATE
statements. It is not a generic SQL parser or a production migration mechanism.
Do not split trigger bodies on semicolons or feed individual physical lines to
D1 `exec`.

This verifies local workerd/D1/R2 API compatibility, not production configuration,
remote authentication, permissions, R2 durability, D1 quotas, multi-region behavior,
realistic 32 MiB memory usage, live data parity or a production cutover. Keep all
production feature flags off until the separate deployment review is complete.
