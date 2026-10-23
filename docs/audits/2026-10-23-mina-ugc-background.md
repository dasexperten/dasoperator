# Mina: UGC background execution repair

The Owner asked Mina to resolve the open ERP background-check failures after Diana's blogger audit. Scope: Direct, payout/content, and the identified Ozon/GEO failures. No manual creator messages or payment execution.

## Confirmed defects

1. A Direct heartbeat extended `next_at` while the concurrency check still used the original `running_since`. After five minutes a new-message probe could admit another run. Completion unconditionally overwrote the state, including a successor's lease. The runner now owns a renewable token lease for the entire lane and uses that token for renewal and completion. The normal 3/15/30-minute delay begins after work completes. Genuine failures retry after three minutes.
2. `captureDmLinks` repeatedly performed per-link database reads for up to 400 old incoming messages. The live baseline contained 177 such messages from 127 handles. A 177-link regression fixture reproduced about 531 reads (including `ensureCreator`) with no new content. Bounded preloads reduce this case to at most nine reads and no writes. Existing links still promote the correct sender to posted; new links retain their source date and the 40-insert limit. Conditional updates preserve a newer concurrent stage.
3. Some partial failures were labelled successful: individual Direct conversation reads, reply failures, content/link failures, and required queue-count reads. These now fail the lane with the failing stage first in the diagnostic and retain the three-minute retry. Successful partial imports remain saved; failed conversation bookmarks remain retryable. A technical reply escalated for review is still an error, while ordinary business review remains successful. A completion that lost its lease now fails instead of looking like recovery.

The adaptive state now stores actual start/completion timestamps, duration and success of the last completed work. A not-due tick does not change this evidence.

## Validation

- Five lease regressions failed before the change; six lease behavior tests now pass.
- Three link-import regressions failed before the change; seven link behavior tests now pass.
- Failure propagation tests exercise the real cron-to-adaptive-runner wiring with external effects mocked. They cover partial success, exceptions, three-minute retry, and ordinary business review.
- Combined cadence, lease, links, cron, Direct watcher/reply, attachment and vision suites: 83 passed, 21 existing skips, zero failures.
- New tests are included in the required CI guard.
- Before rollout, scheduled payout jobs with no changes took roughly 75–183 seconds in the inspected sample. This is a baseline, not a claim that all duration came from link reads.

## Runtime evidence and remaining limit

Both worker schedules and service bindings were read live. Each timer fires every minute and calls `dasoperator-api`; application state controls the actual cadence. Live API before this change: `76ab6e67-dd87-4209-8bc8-0bd844728fb7`.

First deployment: main `b2c645d2f849842769c6fe0cb58c829abf694255`, CI [39949859761](https://github.com/dasexperten/dasoperator/actions/runs/39949859761) successful; live version `4a868667-a4c6-419d-9a81-fe6f16915822`, 100%, 2026-10-23T11:59:02Z. Six naturally due payout runs completed successfully: journal IDs 88731, 88744, 88753, 88773, 88782, 88796. Their reported work duration is 30,426–46,191 ms, median 36,974 ms. Work duration and journal start/end timestamps are distinct measurements; their gap alone does not locate a failure. Five awaiting-approval payouts remain unchanged, total 219,200 minor RUB units.

The naturally due Direct run 88788 completed at 2026-10-23T12:23:55Z: ok=true, stored=0, incoming=0, replied=0, escalated=0, errors=0, waitingOnUs=0. Adaptive state records 147,125 ms of actual work, last_ok=true and the next check 30 minutes after completion. Intervening timer ticks reported running and did not enter a second full pass. This was not a manually invoked reply job.

Final code: main `ecf813e6eab95acfb39f36b843ff00e9cb0e2bb6`; API [CI 39952864872](https://github.com/dasexperten/dasoperator/actions/runs/39952864872), timer [CI 39952864860](https://github.com/dasexperten/dasoperator/actions/runs/39952864860), and Checks all succeeded. Live readback: API `4dd82952-d73c-4020-9e43-21c10730829e`, Ozon sales `f1e1f273-e2e3-4ca3-a9f1-014773c67bb5`, both 100%. Changed source files were byte-verified through GitHub Contents API.

**Not fully closed:** Cloudflare `clientDisconnected` counts and unfinished ERP journal rows remain observations, not a proven common root cause. A client-disconnect metric without request context cannot establish which scheduled step failed. At final inspection, rows 88769 (Direct, started 12:11:01Z) and 88780 (payouts, started 12:17:36Z) still had no end, although later actual work completed. No evidence was fabricated to close those rows. Their cause remains with Mina, board run 11038, next investigation 24 October 2026; the entire ERP is not certified healthy by these successful samples.

Payout sweep extension: explicit registry-read, payment-status refresh, paid/failed notice and thrown reminder failures are accumulated and reported after preserving successful work. The existing numeric success interface, notice claims, retry rules and queued-browser outcomes are preserved. Three additional regressions were red before the fix; all 49 tests in the targeted sweep/execute/rules/cron suites pass.

Scope limits: the hourly auxiliary incident-control call is unchanged. The old Modulbank API job is retired, not a current scheduled failure. Ozon and GEO recovery below were explicitly invoked existing import actions; they were not represented as natural scheduled passes.

## Broader background checks

The Ozon sales failure has a confirmed cause: live read-only `/v2/posting/fbo/list` returned HTTP 400, code 9, `obsolete method cannot be used`. The same authenticated read via v3 returned HTTP 200 with root `postings`, `has_next`, and `cursor`. Ozon's [official retirement notice](https://t.me/s/OzonSellerAPI/660) names 31 August 2026 and the v3 replacement. The importer now follows cursor pagination, preserving the existing date window, cancellation handling, product/warehouse totals and source dates. It replaces the sales snapshot only after an explicit terminal page; an interrupted, malformed or incomplete pagination leaves the previous snapshot intact. Five regressions failed before the fix; twelve focused tests pass including existing WB isolation checks.

The first Ozon production refresh (journal 88784) correctly retained its old 375-row snapshot after HTTP 400. An exact live request exposed v3's additional limit: code 3, limit must be in (0,100]. Page size is now 100; the page ceiling is 400 to preserve the existing 40,000-posting capacity. Two consecutive live read-only cursor pages returned 200 with 100 postings each. After the correction, journal 88800 completed at 2026-10-23T12:25:51Z, ok 1, 405 rows (45 sales + 360 FBO). D1 readback: 360 FBO rows, 15,279 units, period through 23 October instead of 18 October. The former 375-row snapshot is preserved under `mina_erp:261023:ozon_fbo_before`. Existing data-quality gaps remain explicit: 8 unmatched catalogue items and 35 unknown warehouse names (21 aggregate UNKNOWN rows); no mapping was guessed.

The GEO job's existing idempotent snapshot refresh was retried once after inspecting its source and the D1 connection-loss error. No GEO code, schedule or credentials were changed. Journal 88776 completed 2026-10-23T12:18:17Z, ok 1: 10,195 reported rows, including 6,882 GSC rows across 7 available source days. The successful retry establishes current recovery, not that network failures cannot recur.

Notice-evidence repair: two 22 October paid notices lacked their message IDs. Meta Graph GET verified both exact messages, timestamps and amounts against the ERP archive. Their existing payout rows now carry those verified IDs; guarded writes and readback each matched one row. No message was resent and no payment was started. Evidence keys: `mina_erp:261023:notice_evidence:<payout-id>`. Of 122 paid rows labelled delivered, 41 now have IDs and 81 older rows remain without this evidence; their delivery is not inferred.

Official runtime reference: [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/). Both awaiting the handler promise and scheduled `waitUntil` are supported; the existing wrapper's use of `waitUntil` alone was not treated as a defect.

Rollback: revert this change on `main` and deploy through normal CI. It introduces no schema migration or new resource. Existing adaptive JSON remains compatible with the previous reader. Payment approval rules, creator-message content and schedules are unchanged.
