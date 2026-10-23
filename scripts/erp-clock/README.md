# Independent ERP minute transport

Incident: Cloudflare Cron Triggers missed/delayed/duplicated invocations on
2026-10-23 (provider incident `3ts1mfzs0khz`). The ERP API still completed accepted
jobs. This service is a model-free transport clock on the existing non-Hermes
telegramer server, not an agent or an alternate business executor. No new host,
paid resource, inbound port or business schedule is created.

The registry covers44 active timer workers (27 API-backed and17 local), using each worker's exact
configured cron. Direct and payout-status retain their minute probe and ERP
3/15/30 cadence. Payout status does not execute or approve payments. The site
sales rebuild retains its first-Wednesday gate. Cloudflare timers stay enabled.
Weekdays follow Cloudflare1=Sunday..7=Saturday, including the corrected Thursday
WB report. The registry is checked against each source wrangler.toml in CI.

The two transports derive the same run key from worker, cron and UTC minute.
The executor atomically claims that key before business effects. API and local
ownership use separate columns. A claimed pending or terminal slot cannot be
replayed. An interrupted caller that never acquired execution ownership can be
replaced by the other transport. Historical slots are never backfilled. The
journal keeps the source that inserted the row and the source that acquired
execution ownership. Existing WB cross-slot locking remains in force.

Only workers with this ownership contract may use `/scheduled`. Local workers
require the explicit local claim path; adding a name alone is insufficient.
Excluded: intentionally disabled legacy pricing `erp-promo-refill`, provider-
disabled `erp-vn-einvoice`, and the dry monitor `erp-promozon`. They are not revived.

The Python process starts one foreground HTTPS request per due worker at a time.
One slow Direct request does not block the payout-status clock. It holds the
connection for the existing 15-minute scheduled execution budget, with no local
retry of ambiguous work. Logs contain only worker, minute, HTTP/transport status
and timing; credentials and response bodies never appear in argv or logs.

## Release

1. Commit/push migrations0139/0140 separately from runtime, verify their bytes
   through GitHub Contents, apply to ERP D1 and read back the six nullable columns.
2. Push runtime+clock to main; verify GitHub Contents. Let the normal guarded CI
   deploy API and affected timer workers. Both deployment orders are compatible
   after the migrations; do not activate the external clock until both are live.
3. From that exact clean main, `git archive HEAD:scripts/erp-clock` into the remote
   immutable `/opt/dasoperator-erp-clock/releases/<full SHA>`. Compare every file's
   SHA256 to the local tracked source. Keep release directories for rollback.
4. Deliver `ERP_RUN_SECRET` from the existing vault to
   `/etc/dasoperator-erp-clock.env` via SSH stdin, root-owned0600. No value in git,
   shell arguments, user reports or deployment logs. Do not replace another key.
5. Check server time sync. In the release directory run `sh install.sh <SHA>`.
   It tests/prepares the release and unit but does not start it. Run
   `ERP_CLOCK_LOCK=/tmp/erp-clock-dry.lock python3 clock.py --dry-run --once`;
   dry mode never contacts ERP. Remove the dry lock afterward. On an upgrade,
   drain/stop the old clock before switching its release symlink, then restart
   after verification. Do not run two clock processes intentionally.
6. Wait until the UTC minute following the last timer deployment; check legacy
   unfinished local runs. The new wrapper refuses local work over a legacy
   invocation still within its existing15-minute execution budget. Unknown
   ownership is not a reason to clear the old row or repeat business effects.
   `systemctl enable --now dasoperator-erp-clock.service` starts the natural
   schedule; never run manual business `/run` as a connectivity probe.
7. Read systemd journal, live `/health`, and D1 source/ownership/terminal metadata.
   Reconcile observed slots, business deliveries and provider status. Healthy
   process status alone is not acceptance.

## Rollback

`systemctl disable --now dasoperator-erp-clock.service` stops future external
wakeups and drains existing requests within the15-minute budget. Cloudflare
timers remain enabled throughout. Runtime rollback is a revert on main followed
by normal CI deploy. The additive nullable migration can remain. Preserve API
ownership records; never clear them to force an ambiguous job to execute again.

## Verification

`python3 -m unittest discover -s scripts/erp-clock -p 'test_*.py'`
and `node --test workers/_shared/run-slot.test.mjs` are mandatory CI checks.
The slot suite exercises real SQLite journal writes and concurrent API claims;
the clock suite verifies no catch-up, no retries, concurrency and secret handling.
