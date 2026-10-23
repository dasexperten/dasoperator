# Independent ERP minute transport

Incident: Cloudflare Cron Triggers missed/delayed/duplicated invocations on
2026-10-23 (provider incident `3ts1mfzs0khz`). The ERP API still completed accepted
jobs. This service is a model-free transport clock on the existing non-Hermes
telegramer server, not an agent or an alternate business executor. No new host,
paid resource, inbound port or business schedule is created.

Phase 1 addresses `erp-ugc-direct` and `erp-ugc-payouts`. The latter reads payout
status; it does not execute or approve payments. Both retain their existing
minute probe and ERP 3/15/30 cadence. Cloudflare timers stay enabled.

The two transports derive the same run key from worker, cron and UTC minute.
The API atomically claims that key before business effects. An API-owned pending
or terminal slot cannot be replayed. A pre-API interrupted caller can be replaced
by the other transport. Historical slots are never backfilled. The journal keeps
both the source that inserted the row and the source that acquired API ownership.

Only API-backed workers with this ownership contract may use `/scheduled`.
Self-contained workers must not be enabled merely by adding their names.

The Python process starts one foreground HTTPS request per worker at a time.
One slow Direct request does not block the payout-status clock. It holds the
connection for the existing 15-minute scheduled execution budget, with no local
retry of ambiguous work. Logs contain only worker, minute, HTTP/transport status
and timing; credentials and response bodies never appear in argv or logs.

## Release

1. Commit/push migration0139 alone, verify its bytes through GitHub Contents,
   apply to ERP D1 and read back all three nullable columns.
2. Push runtime+clock to main; verify GitHub Contents. Let the normal guarded CI
   deploy API and affected timer workers. Both deployment orders are compatible
   after the migration; do not activate the external clock until both are live.
3. From that exact clean main, `git archive HEAD:scripts/erp-clock` into the remote
   immutable `/opt/dasoperator-erp-clock/releases/<full SHA>`. Compare every file's
   SHA256 to the local tracked source. Keep release directories for rollback.
4. Deliver `ERP_RUN_SECRET` from the existing vault to
   `/etc/dasoperator-erp-clock.env` via SSH stdin, root-owned0600. No value in git,
   shell arguments, user reports or deployment logs. Do not replace another key.
5. Check server time sync. In the release directory run `sh install.sh <SHA>`.
   It tests/prepares the release and unit but does not start it. Run
   `ERP_CLOCK_LOCK=/tmp/erp-clock-dry.lock python3 clock.py --dry-run --once`;
   dry mode never contacts ERP. Remove the dry lock afterward.
6. `systemctl enable --now dasoperator-erp-clock.service`. This starts the natural
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
