# Mina: UGC background execution repair

The Owner asked Mina to resolve the open ERP background-check failures after Diana's blogger audit. Scope: the Direct and payout/content lanes; no manual creator messages or payment execution.

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

First deployment: main `b2c645d2f849842769c6fe0cb58c829abf694255`, CI [39949859761](https://github.com/dasexperten/dasoperator/actions/runs/39949859761) successful; live version `4a868667-a4c6-419d-9a81-fe6f16915822`, 100%, 2026-10-23T11:59:02Z. Two naturally due payout runs finished successfully with actual work durations 33,280 and 39,181 ms in adaptive state. Their journal IDs are 88731 and 88744. The second journal write completed later than the work; duration and journal completion are distinct measurements. Five awaiting-approval payouts remain unchanged, total 219,200 minor RUB units.

Cloudflare `clientDisconnected` counts and old unfinished ERP journal rows remain observations, not a proven common root cause. A client-disconnect metric without its request context cannot establish which scheduled step failed. Final failure-propagation deployment and a naturally due Direct pass remain to be read back.

Scope limits: the hourly auxiliary incident-control call is unchanged; internally suppressed failures in the numeric payout sweep are not represented by the new cron status. This audit does not certify every ERP job. The latest Ozon sales job returned HTTP 400, and the latest GEO snapshot reported a D1 connection loss. The old Modulbank API job is retired, not a current scheduled failure.

Official runtime reference: [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/). Both awaiting the handler promise and scheduled `waitUntil` are supported; the existing wrapper's use of `waitUntil` alone was not treated as a defect.

Rollback: revert this change on `main` and deploy through normal CI. It introduces no schema migration or new resource. Existing adaptive JSON remains compatible with the previous reader. Payment approval rules, creator-message content and schedules are unchanged.
