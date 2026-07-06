# 2026-07-06 — Orders → CRM integration: status & waiting on merge

## Where things stand
The Phase 12.0 build (see `2026-07-04_orders-crm-integration.md`) is complete and
sitting in two **draft PRs awaiting review/merge**:

- **dasoperator#94** — https://github.com/dasexperten/dasoperator/pull/94
  The whole integration: Stripe-direct ingest (webhook + hourly poller), D1
  tables `crm_customers`/`crm_orders`/`crm_webhook_log`/`crm_sync_state`
  (migration 0060), R2 raw-JSON archive in `das-loyalty-customers` under
  `crm/` (`CUSTOMERS_DB` binding), Wix + RetailCRM backfill endpoints, and the
  `/crm` storefront source pill (.ru KIT ₽ ↔ .com Stripe $).
  Cloudflare Pages preview build is **green**
  (https://claude-orders-crm-integratio.dasoperator.pages.dev). Mergeable, no
  review comments as of 2026-07-06.
- **dasexperten.com#13** — https://github.com/dasexperten/dasexperten.com/pull/13
  Work-log only (the 07-04 BACKLOGS entry + this one). No site changes.

## Monitoring
- The build session is subscribed to both PRs' webhook events (review comments
  and CI failures arrive immediately).
- A **daily self-check at 12:00 UTC** (trigger "Daily PR check: orders→CRM
  integration (#94, #13)") re-verifies state/CI/mergeability and deletes
  itself once both PRs are merged or closed.
- Checks so far (through 2026-07-06): no review activity, both PRs unchanged
  since creation.

## Blocked on
Aram merging **dasoperator#94** (and #13). Nothing goes live on merge by
itself — ingestion starts only after the go-live steps.

## Go-live checklist after merge (runbook: dasoperator/docs/notes/crm-website-orders.md)
1. `POST /admin/migrate/crm-website` (admin bearer) — create the D1 tables.
2. `wrangler secret put STRIPE_SECRET_KEY` (rk_live from `SECRETS/stripe.md` §2)
   → hourly poller starts ingesting on its own.
3. Optional real-time webhook: Stripe Dashboard → add endpoint
   `…/api/crm/website/webhook/stripe` (`payment_intent.succeeded`,
   `charge.refunded`) → `wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. Optional full Stripe history pull: `POST /api/crm/website/sync/stripe`
   with `{"since": …}`.
5. Backfills: `WIX_API_KEY`/`WIX_SITE_ID` secrets (`SECRETS/wix.md`) →
   `POST /api/crm/website/backfill/wix`; then
   `POST /api/crm/website/backfill/retailcrm` (creds already on the Worker).
6. Place one real $ test order; check `/crm` → pill "dasexperten.com" and the
   R2 `crm/` prefix.
7. `tools/pull-cloudflare.sh` in this repo to refresh the `infra/` mirror
   (new `CUSTOMERS_DB` binding + `7 * * * *` cron will appear).
