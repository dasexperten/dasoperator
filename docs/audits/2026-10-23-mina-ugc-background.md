# Mina: UGC background execution repair

The Owner asked Mina to resolve the open ERP background-check failures after Diana's blogger audit. Scope: the Direct and payout/content lanes; no manual creator messages or payment execution.

## Confirmed defects

1. A Direct heartbeat extended `next_at` while the concurrency check still used the original `running_since`. After five minutes a new-message probe could admit another run. Completion unconditionally overwrote the state, including a successor's lease. The runner now owns a renewable token lease for the entire lane and uses that token for renewal and completion. The normal 3/15/30-minute delay begins after work completes. Genuine failures retry after three minutes.
2. `captureDmLinks` repeatedly performed per-link database reads for up to 400 old incoming messages. The live baseline contained 177 such messages from 127 handles. A 177-link regression fixture reproduced about 531 reads (including `ensureCreator`) with no new content. Bounded preloads reduce this case to at most nine reads and no writes. Existing links still promote the correct sender to posted; new links retain their source date and the 40-insert limit. Conditional updates preserve a newer concurrent stage.

The adaptive state now stores actual start/completion timestamps, duration and success of the last completed work. A not-due tick does not change this evidence.

## Validation

- Five lease regressions failed before the change; six lease behavior tests now pass.
- Three link-import regressions failed before the change; five link behavior tests now pass.
- Combined cadence, lease, link, Direct, attachment and vision suites: 70 passed, 21 existing skips, zero failures.
- New tests are included in the required CI guard.
- Before rollout, scheduled payout jobs with no changes took roughly 75–183 seconds in the inspected sample. This is a baseline, not a claim that all duration came from link reads.

## Runtime evidence and remaining limit

Both worker schedules and service bindings were read live. Each timer fires every minute and calls `dasoperator-api`; application state controls the actual cadence. Live API before this change: `76ab6e67-dd87-4209-8bc8-0bd844728fb7`.

Cloudflare `clientDisconnected` counts and old unfinished ERP journal rows remain observations, not a proven common root cause. A client-disconnect metric without its request context cannot establish which scheduled step failed. No deployment claim is made here until the follow-up readback records the live version and actual due-run outcomes.

Official runtime reference: [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/). Both awaiting the handler promise and scheduled `waitUntil` are supported; the existing wrapper's use of `waitUntil` alone was not treated as a defect.

Rollback: revert this change on `main` and deploy through normal CI. It introduces no schema migration or new resource. Existing adaptive JSON remains compatible with the previous reader. Payment approval rules, creator-message content and schedules are unchanged.
