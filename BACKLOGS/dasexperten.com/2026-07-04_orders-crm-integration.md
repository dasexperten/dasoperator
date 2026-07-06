# 2026-07-04 — Website orders → dasoperator CRM (customer database in D1 + R2)

## Problem
A paid `.com`/`.de` order lived only in Stripe (PaymentIntent), NSS and two
emails — **no customer/order database anywhere** (confirmed in
`2026-07-03_order-confirmation-emails.md`). RetailCRM only received loyalty
signups via `loyalty-bridge`, never purchases. There was no place to see
website customers, repeat buyers, or lifetime spend.

## Fix (implemented in the `dasoperator` repo, branch `claude/orders-crm-integration-owbr7m`)
dasoperator-api now ingests website orders **directly from Stripe** — the
checkout Worker (`dasexperten-checkout`, source in das-architektura) is NOT
touched:

1. **Webhook** `POST /api/crm/website/webhook/stripe` — `payment_intent.succeeded`
   + `charge.refunded`, verified with `STRIPE_WEBHOOK_SECRET` (registered in the
   Stripe dashboard; optional).
2. **Hourly poller** (cron `7 * * * *`) — lists succeeded PaymentIntents since a
   D1 cursor and re-ingests; also sweeps refunds. Works with only
   `STRIPE_SECRET_KEY` (rk_live from `SECRETS/stripe.md` §2) — the webhook is an
   accelerator, not a dependency.

Order data comes from PI metadata (`order_number`, `email`, `items`,
`subtotal_cents`, `fee_cents`, `lang` — set by the checkout Worker since
2026-07-03) + `pi.shipping`.

**Storage (hybrid, per dasoperator ADR-001):**
- D1 `das_erp_dev`: `crm_customers`, `crm_orders`, `crm_webhook_log`,
  `crm_sync_state` — queryable CRM. Field model informed by Wix (order number,
  recipient, line items) and Shopify (financial/fulfillment status, marketing
  consent, tags, orders_count/total_spent/first-last order). Money in cents.
- R2 `das-loyalty-customers` (bound to dasoperator-api as `CUSTOMERS_DB`):
  raw JSON of every order + customer under the `crm/` prefix —
  `crm/orders/{source}/{number}.json`, `crm/customers/{id}.json`. The bucket is
  shared with `loyalty-bridge` (top-level keys untouched).

**Customer identity:** lowercased email → E.164 phone (same `normalizePhone`
as the loyalty engine). Lifetime aggregates count website (USD) orders only.

**Backfills (admin endpoints, run post-deploy):**
- `POST /api/crm/website/backfill/wix` — 44 historical Wix orders + 35 members
  (`source=wix`; needs `WIX_API_KEY`/`WIX_SITE_ID` from `SECRETS/wix.md`).
- `POST /api/crm/website/backfill/retailcrm` — ~1507 RetailCRM customers
  (`source=retailcrm`; RETAIL_CRM_* already on the Worker). Imports only fill
  gaps — live checkout data always wins.

**UI:** `dasoperator.pages.dev/crm` got a storefront source pill —
`dasexperten.ru (Yandex KIT · ₽)` ↔ `dasexperten.com (Stripe · $)` — switching
the KPI strip and the Orders/Customers tabs. `.ru` view unchanged.

## Go-live (after dasoperator PR merges → auto-deploy)
See the full runbook `dasoperator/docs/notes/crm-website-orders.md`:
migrate tables → `wrangler secret put STRIPE_SECRET_KEY` → optional webhook +
`STRIPE_WEBHOOK_SECRET` → optional history pull + Wix/RetailCRM backfills.

## This repo
No site changes needed — checkout flow is untouched. This entry is the work
log; the Cloudflare state mirror (`infra/workers-r2-config.md`,
`infra/workers.json`) will pick up the new `CUSTOMERS_DB` binding + cron on the
next `tools/pull-cloudflare.sh` after deploy.

## Next steps
- Merge the dasoperator PR, run the runbook steps, place one $ test order.
- Decide whether new website orders should ALSO forward to RetailCRM
  (`SECRETS/retail-crm.md` lists ERP order sync as planned) — out of scope here.
- Later: tracking numbers into `crm_orders` via NSS `order.shipped` (today the
  checkout Worker only emails them).
