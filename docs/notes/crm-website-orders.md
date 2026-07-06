# Website CRM — dasexperten.com orders → dasoperator (Phase 12.0)

> 2026-07-04. Connects the `.com` storefront (Stripe checkout) to the ERP:
> every paid order lands in D1 (`crm_orders` / `crm_customers`) with the raw
> JSON archived to R2, and shows up on `/crm` behind the **dasexperten.com**
> source pill. Historical Wix orders/members and RetailCRM customers can be
> backfilled into the same customer database.

## Architecture

```
Stripe (acct Das Experten International LLC, checkout Worker dasexperten-checkout)
   │  payment_intent.succeeded / charge.refunded
   ├──────────────► POST /api/crm/website/webhook/stripe   (real-time, signature-verified)
   │
   └──◄─ hourly poll "7 * * * *" (scheduled.ts → pollStripeOrders)  (safety net + refunds)
                        │
                        ▼
             api/src/lib/crm-website.ts  upsertOrder()/upsertCustomer()
                        │                        │
              D1 das_erp_dev                R2 das-loyalty-customers (CUSTOMERS_DB)
              crm_orders                    crm/orders/{source}/{number}.json
              crm_customers                 crm/customers/{cust_id}.json
              crm_webhook_log               crm/imports/…
              crm_sync_state
                        │
                        ▼
              GET /api/crm/website/{stats,orders,customers}
                        │
                        ▼
              dasoperator.pages.dev/crm — source pill "dasexperten.com · Stripe · $"
```

The checkout Worker (`das-architektura/PROJECTS/dasexperten-de-website/_stripe/worker`)
is NOT modified — ingestion reads the order from the PaymentIntent itself
(metadata: `order_number`, `email`, `items`, `subtotal_cents`, `fee_cents`,
`lang`; plus `pi.shipping`). The `.ru` CRM (`/api/crm/*`, Yandex KIT) is untouched.

The data model borrows from Wix (order_number, recipient address, line items)
and Shopify (financial_status / fulfillment_status, marketing_consent, tags,
orders_count / total_spent / first-last order aggregates). Money is INTEGER
cents; website orders are USD. Customer identity = lowercased email, falling
back to E.164 phone (same normalizePhone as loyalty).

## Go-live steps (after merge to main → auto-deploy)

1. **Create tables** (idempotent):
   ```
   curl -X POST https://dasoperator-api.dasexperten.workers.dev/admin/migrate/crm-website \
        -H 'Authorization: Bearer das-admin-2026-migrations'
   ```
2. **Set the Stripe key** (restricted live key, dasexperten.com repo `SECRETS/stripe.md` §2):
   ```
   cd api && npx wrangler secret put STRIPE_SECRET_KEY
   ```
   From this moment the hourly poller ingests orders on its own.
3. **First pull of the whole Stripe history** (optional, otherwise cursor starts 90 days back):
   ```
   curl -X POST https://dasoperator-api.dasexperten.workers.dev/api/crm/website/sync/stripe \
        -H 'Authorization: Bearer das-admin-2026-migrations' \
        -H 'Content-Type: application/json' -d '{"since": 1735689600}'
   ```
4. **Real-time webhook** (optional but recommended): Stripe Dashboard →
   Developers → Webhooks → Add endpoint
   `https://dasoperator-api.dasexperten.workers.dev/api/crm/website/webhook/stripe`
   with events `payment_intent.succeeded`, `charge.refunded`; then
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET` (the whsec_…).
   Until then the endpoint answers 503 by design and the poller carries everything.
5. **Backfill Wix** (44 orders + 35 members, creds in dasexperten.com repo `SECRETS/wix.md`):
   ```
   npx wrangler secret put WIX_API_KEY
   npx wrangler secret put WIX_SITE_ID        # site 0c388495-…
   # optional: npx wrangler secret put WIX_ACCOUNT_ID
   curl -X POST https://dasoperator-api.dasexperten.workers.dev/api/crm/website/backfill/wix \
        -H 'Authorization: Bearer das-admin-2026-migrations'
   ```
6. **Backfill RetailCRM customers** (~1507; RETAIL_CRM_DOMAIN/TOKEN are already on the Worker):
   ```
   curl -X POST https://dasoperator-api.dasexperten.workers.dev/api/crm/website/backfill/retailcrm \
        -H 'Authorization: Bearer das-admin-2026-migrations'
   ```
7. **Verify**: `GET /api/crm/website/stats` shows counts; `/crm` → pill
   "dasexperten.com" shows the orders/customers; R2 bucket
   `das-loyalty-customers` has objects under `crm/`.

## Semantics & decisions

- **Idempotency**: orders are unique by `stripe_payment_intent` and by
  `(source, order_number)`; re-ingesting is a no-op. Webhook deliveries are
  logged to `crm_webhook_log` (same discipline as `loyalty_webhook_log`).
- **Aggregates** (`orders_count`, `total_spent_cents`) count **website (USD)
  orders only** and are recomputed from `crm_orders` on every ingest.
  Wix/RetailCRM history never inflates them; Wix orders still appear in the
  orders list with `source=wix`, and raw RetailCRM rows are archived at
  `crm/imports/retailcrm/customers.json`.
- **Imports fill gaps only**: `upsertCustomer(…, {fillOnly:true})` COALESCEs
  into NULL columns, so live checkout data always wins over Wix/RetailCRM.
- **Refunds**: the poller sweeps `/v1/refunds` each run and flips
  `financial_status` to `refunded`/`partially_refunded` (webhook
  `charge.refunded` triggers the same sweep immediately).
- **R2 bucket sharing**: `das-loyalty-customers` is also written by the
  `loyalty-bridge` Worker (top-level keys). dasoperator only touches the
  `crm/` prefix — do not write outside it.
- **Auth**: read endpoints are open like the rest of `/api/crm/*` (SSO is
  BACKLOG item M); mutations require the `/admin/*` bearer; the webhook is
  gated by Stripe signature verification.

## Files

- `db/migrations/0060_crm_website.sql` — schema (also `POST /admin/migrate/crm-website`)
- `api/src/lib/crm-website.ts` — DDL, canonical shapes, upserts, Stripe client,
  signature verify, poller, Wix/RetailCRM backfills
- `api/src/routes/crm-website.ts` — `/api/crm/website/*`
- `api/src/scheduled.ts` — `7 * * * *` dispatch
- `api/wrangler.toml` — `CUSTOMERS_DB` binding + cron
- `web/app/crm/page.tsx` — source pills, .com KPI strip, .com table variants
