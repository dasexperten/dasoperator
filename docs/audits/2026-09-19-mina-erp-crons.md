# Mina: ERP cron audit

As of: 2026-09-19, 16:17 Yerevan (UTC+4). Audit only; no code, schedules, keys, business records, or production deployments changed.
Source reviewed: dasoperator origin/main `f0bdf4ea`. Live Cloudflare account inventory, schedule/binding API responses, ERP D1 execution logs and aggregate business-table freshness were read during this session.

## Verdict

Not all jobs are healthy. All 49 erp-* Workers respond to /health using curl; 48 have cron schedules and erp-inventory is email-driven. All 48 live schedules match the repository; dasoperator-api retains its two model-bearing schedules. Every erp-* deployment has an ERP_RUN_SECRET binding. Health responses prove reachability, not work completion.

In the fixed 24-hour window 18 September 16:00–19 September 16:00 Yerevan, 42 timer Workers logged 2,502 runs, including 8 failed rows and 21 dry rows. This is not a success-rate claim: some successful rows conceal failures. Six weekly/monthly jobs have no run yet; their first scheduled dates have not arrived since migration. Email-driven inventory has no erp_cron_runs row; no real stock email was submitted by this audit.

## Confirmed findings

1. **High — WB daily sales is stale.** Last business-table update: 18 September 12:59:44 Yerevan, 31 rows. The scheduled slot produced two starts 11 seconds apart: one was cut off and one immediately failed with 429. No successful scheduled WB sales run is present since migration. `workers/_marketplace/erp-sales-sync.mjs:690` fails immediately on a statistics API rate limit; its funnel loop at 577–579 retries forever on 429. The exact cause of the first cut-off remains unproven.
2. **High — Ozon cluster stock sync intermittently fails.** Four of eight scheduled runs since migration failed with 429 (including 19 September 16:01). Aggregate stock still updated to 46 rows at 16:01, while the cluster table retained 495 rows from 14:00:21. This is partial freshness, not total loss. `erp-stocks-sync.mjs` calls analytics/stocks without retry/backoff and reports the cluster error after committing aggregate stocks.
3. **High — success logging hides actual failures.** Latest promo-refill row is ok=1 while its note contains two Ozon action-product 404 errors (actions 3684628 and 3702380). `api/src/cron-steps.ts` serializes the result without checking errors. Many legacy branches in `scheduled.ts` similarly catch/log exceptions and return normally, while `internal-cron.ts` translates normal return to ok=true. Jobs needing inspection include ads, delivery, Skladbot, web analytics, watchdog, reports and pulse warming. Current successful data for some of these does not remove the reporting defect.
4. **High — FBO finishes in the timer log before its work finishes.** `scheduled.ts:794` puts runFboSync in the HTTP request's waitUntil context, then the internal route returns success. The 19 September run logged completion in 354 ms. WB cluster stocks still date from 18 September 09:01:02. The actual FBO result (which can itself contain error/partial_error) is not propagated. Early success is confirmed; the precise cause of stale WB cluster data needs runtime logs.
5. **Medium — weekly expected-run checker uses the wrong weekday convention.** `api/src/lib/cron-expect.ts` treats 1 as Monday and 7 as Sunday. Cloudflare uses 1=Sunday through 7=Saturday. A direct reproduction gives zero expected fires on Sunday 20 September for live expression `6 20 * * 1`, even though Cloudflare schedules it then. Existing tests pass because they repeat the same wrong assumption. This affects the guard and interpretation of numeric weekly schedules. Do not silently change business weekdays without checking the intended cadence. Primary reference: https://developers.cloudflare.com/workers/configuration/cron-triggers/ .
6. **Medium — duplicate starts have no execution lock.** WB sales, ru-track and promo-refill have duplicate starts for one scheduled minute. `_shared/run.ts` records each invocation without a scheduled-time uniqueness key or lock. Duplicates are observed; why Cloudflare delivered them is not established. External effects depend on each job's own idempotency.
7. **Medium — alert delivery can be lost permanently.** `erp-cron-failures.ts` sets notified=1 before reportCronFailure. `owner-telegram.ts` returns false on failed delivery; auto-healer ignores that return. The row therefore looks notified even if Telegram fails. This is a code-confirmed failure path, not proof that today's messages were lost. No test message was sent.
8. **Medium — email relink count is not a count of new links.** Latest run reports 82 linked; repeated logs show the same count. The sweeper queries known keys per mailbox, while linkEmail checks global mail_key and can return early or swallow errors. The outer loop increments linked regardless. Confirmed misleading counter; which of the 82 are duplicates versus insertion failures was not established.

## Known operating limitations, not newly introduced bugs

- Modulbank polling is deliberately dry because Cloudflare could not validate the bank certificate. Latest stored bank transaction is 18 August. Webhook restoration/backfill remains unverified; no bank settings or data were changed.
- Promozon returns nested dryRun=true and actionsTaken=0, while the outer run has dry_run=0. Its deliberate no-action mode must not be described as active campaign management.
- Social queue execution is alive, but results contain blocked/historical-review-required articles. A green timer is not evidence of publishing. No publications were made by this audit.
- Some WB aggregate stock rows date from 5 September while current rows updated today; whether these are obsolete offers needs a separate SKU-level reconciliation.

## Positive evidence

- Ozon sales: 44 rows updated 19 September 02:01 Yerevan.
- WB stock sync: successful current runs; latest health and keys present.
- FX: 5 CBR rates and 17 pricing rates reported today.
- Website analytics: GA4 and Metrika both contain 18 September data.
- Latest five Ozon Performance reports have status ok and downloaded timestamps.
- Site order mirror reported 1,873 of 1,873 records; site stock reported 47 offers pushed.
- Site-stock authorization and review-canon authorization failures from migration were followed by successful runs. The transient ru-track 502 also recovered.

## Coverage and limitations

Configuration and common wrapper review covered every ERP Worker, the internal cron dispatcher and both remaining ERP API cron branches. Output freshness was sampled in the relevant business tables; every business side effect was not replayed. The two model-bearing dasoperator-api crons are configured, but their individual end-to-end outputs were not proved by the erp_cron_runs table. No outbound messages, purchases, orders, promotions, payments, or manual cron runs were triggered. Private raw logs stay local; this report contains only operational summaries.

The initial Python /health requests returned 403 for all Workers; curl subsequently returned valid ok=true responses for all 49. Those client rejections are not reported as Worker outages.

Checks: `node scripts/check-erp-workers.mjs` passed for 49 Workers. Existing cron-expect tests passed (3/3), but the independent Cloudflare weekday reproduction exposes the convention bug.

## Job-by-job run coverage

Times below are Yerevan. “Logged OK” means the wrapper returned success; it is not an end-to-end certification. Details above take precedence.

| Worker | Latest run | Logged state | Audit qualification |
|---|---|---|---|
| erp-auto-delivery | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-bank-match | 19 Sep 06:00 | Logged OK | Run observed; see scope limits |
| erp-daily-digest | 19 Sep 07:00 | Logged OK | Run observed; see scope limits |
| erp-fbo-sync | 19 Sep 09:01 | Logged OK | Early success; WB cluster data stale |
| erp-fx-rates | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-geo-snapshot | 19 Sep 04:45 | Logged OK | Run observed; see scope limits |
| erp-inbox-reconcile | 19 Sep 04:40 | Logged OK | Run observed; see scope limits |
| erp-inventory | — | No run | Email-driven, no real mail replayed |
| erp-loyalty-keys | 19 Sep 16:04 | Logged OK | Run observed; see scope limits |
| erp-lubertsy-invoices | 19 Sep 15:15 | Logged OK | Run observed; see scope limits |
| erp-mail-index | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-mail-relink | 19 Sep 15:35 | Logged OK | 82 is not verified new-link count |
| erp-mail-retention | — | No run | First weekly/monthly slot not yet reached |
| erp-mail-scenarios | 19 Sep 13:23 | Logged OK | Stamps scenario timestamps only; does not execute scenarios |
| erp-mail-snapshot | 19 Sep 16:08 | Logged OK | Run observed; see scope limits |
| erp-marketplace-fifo | 19 Sep 04:50 | Logged OK | Run observed; see scope limits |
| erp-marketplace-pull | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-modulbank-sync | 19 Sep 15:15 | DRY | Deliberately dry; bank data stale |
| erp-orders-drop-watch | 19 Sep 08:00 | Logged OK | Run observed; see scope limits |
| erp-ozon-ads-poll | 19 Sep 16:08 | Logged OK | Run observed; see scope limits |
| erp-ozon-ads-reports | 19 Sep 16:05 | Logged OK | Run observed; see scope limits |
| erp-ozon-monthly-report | — | No run | First weekly/monthly slot not yet reached |
| erp-ozon-notices | 19 Sep 16:04 | Logged OK | Run observed; see scope limits |
| erp-ozon-sales | 19 Sep 02:00 | Logged OK | Run observed; see scope limits |
| erp-ozon-stocks | 19 Sep 16:01 | FAILED | Partial refresh; cluster 429 |
| erp-ozon-turnover | 19 Sep 00:04 | Logged OK | Run observed; see scope limits |
| erp-ozon-week | — | No run | First weekly/monthly slot not yet reached |
| erp-partner-status | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-promo-refill | 19 Sep 16:01 | Logged OK | False green: two embedded 404 errors |
| erp-promozon | 19 Sep 16:01 | Logged OK | Nested dryRun=true; no campaign actions |
| erp-pulse-warm | 19 Sep 05:00 | Logged OK | Run observed; see scope limits |
| erp-review-canon | 19 Sep 13:45 | Logged OK | Run observed; see scope limits |
| erp-ru-orders | 19 Sep 16:02 | Logged OK | Run observed; see scope limits |
| erp-ru-track | 19 Sep 16:01 | Logged OK | Run observed; see scope limits |
| erp-site-order-retry | 19 Sep 16:07 | Logged OK | Run observed; see scope limits |
| erp-site-orders | 19 Sep 16:07 | Logged OK | Run observed; see scope limits |
| erp-site-sales-rebuild | — | No run | First weekly/monthly slot not yet reached |
| erp-site-stock | 19 Sep 13:10 | Logged OK | Run observed; see scope limits |
| erp-skladbot-sync | 19 Sep 10:30 | Logged OK | Run observed; see scope limits |
| erp-social-queue | 19 Sep 16:05 | Logged OK | Queue active; article validation blocks present |
| erp-watchdog | 19 Sep 13:20 | Logged OK | Notification flag does not prove delivery |
| erp-wb-news | 19 Sep 16:05 | Logged OK | Run observed; see scope limits |
| erp-wb-ryazan-watch | 19 Sep 14:35 | Logged OK | Run observed; see scope limits |
| erp-wb-sales | 19 Sep 02:15 | FAILED | Stale data; latest scheduled slot failed twice |
| erp-wb-stocks | 19 Sep 14:15 | Logged OK | Run observed; see scope limits |
| erp-wb-turnover | 19 Sep 00:05 | Logged OK | Run observed; see scope limits |
| erp-wb-week | — | No run | First weekly/monthly slot not yet reached |
| erp-wb-weekly-report | — | No run | First weekly/monthly slot not yet reached |
| erp-web-analytics | 19 Sep 06:30 | Logged OK | Run observed; see scope limits |

## Repair order

1. Make result reporting truthful and await FBO completion; propagate partial failures and dry/skipped states.
2. Fix bounded API retry behavior and prevent overlapping scheduled executions, then verify fresh WB sales and Ozon cluster rows.
3. Correct the guard to Cloudflare cron semantics and preserve intended business weekdays.
4. Acknowledge notifications only after confirmed delivery; correct relink accounting.
5. Recheck weekly/monthly jobs on their first real slots. Keep the bank dry mode and promotion dry mode until their existing operating decisions are resolved.

No repairs or deployments are claimed in this report.

## WB repair, Owner scope clarified 19 September

- `dasoperator-api` owns stock/sales WB egress using the existing Arina credential (`SECRETS/wb-arina.md`). Its private `WbGateway` entrypoint is not a public proxy.
- Tamara has a distinct care function and credential: her code, bindings and care calls remain unchanged.
- Retire WB FBO sync (including manual sync and ingest); preserve historical snapshots and continue Ozon FBO. Await Ozon results before reporting success.
- ERP timers use shared WB cooldowns and bounded retries; scheduled duplicates and overlapping WB runs are suppressed.
- Close Arina's obsolete public sync endpoints and retire the old unscheduled `marketplace-sync`. Remove redundant WB bindings after deployment.
- Manual pulse refresh goes to ERP sales timers, including Ozon.

Deployment order: gateway/schema first, then ERP clients and Arina/legacy retirement, then remove duplicate secrets. Schema is additive. Rollback: revert affected source commits through main and redeploy; keep the additive tables. Restore timer credentials from Arina vault only if rolling the clients back to direct egress; do not touch Tamara.

Validation before deployment: gateway concurrency, persisted cooldown, destination allowlist, bounded retry, duplicate cron/manual exclusion, and retired WB FBO tests pass; ERP API bundles successfully. Live results will be recorded after rollout.
