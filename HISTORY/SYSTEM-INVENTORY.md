# Das Operator ERP — System Inventory

Snapshot of the whole live system as of 2026-07-03. "Everything we have,"
organized by domain. Counts: **65 API route modules · 53 backend libs ·
41 UI pages · 30 components · 60 migrations.**

The API is a single Cloudflare Worker (`dasoperator-api`, Hono) reporting
`version 1.8.0 / phase 7.0-bank-integration` at its root. Routes are mounted in
[`../api/src/index.ts`](../api/src/index.ts).

---

## Backend — API route modules (`api/src/routes/`)

Grouped by business domain. Mount prefix in parentheses.

### Core commercial
- **operations** (`/api/operations`) — the heart: purchase/sale/service/transfer/
  tax lifecycle. Plus `operations-import` (`/parse-excel`), `operation-docs`,
  `operation-documents`, `operation-document-sources`.
- **partners** (`/api/partners`) — buyers/suppliers/shippers; `net-balance`,
  `partners-parse-create`.
- **products** (`/api/products`) — catalog; `products-pricing`, `products-photos`,
  `products-landed-cost`, `price-types`, `pricer`.
- **contracts** (`/api/contracts`) — registry + R2 files.
- **contacts** (`/api/contacts`), **directories** (`/api`) — companies + manufacturers.
- **payments** (`/api/payments`), **fx** (`/api/fx`), **sequences** (`/api/sequences`).

### Documents / Invoicer
- **documents** (`/api/documents`) — CI/PL/IS/UPD/TN/RFQ registry + issue/download.
- **document-extractions** (`/api/document-extractions`).
- **attachments** / **attachment-files** — operation file uploads.

### Inventory / Warehouses
- **warehouses**, **stocks**, **stock-movements**, **inventory-sessions**,
  **bundling**, **external-stocks**.

### Marketplaces
- **marketplaces** + **marketplaces-extras** + **marketplaces-promos** (the three
  largest route files — Ozon + WB stocks/sales/promos/CPC), **marketplace-pull**,
  **marketplace-match**, **mp-feeds** (reviews/questions ingest), **reviews**,
  **wb-health**, **sales-breakdown** (`/api/dashboard`).

### Finance / Banking
- **banks-modulbank** (`/api/banks/modulbank`) — largest banking module, webhook +
  cron, 3-state matching.
- **bank-statements**, **bank-statement-sources**, **bank-match-rules**,
  **finance-categories**, **agent-settlements**, **net-balance**.

### Inbox pipeline
- **inbox** (`/api/inbox`) + **inbox-banking** (the two largest route files
  overall) — email/telegram invoice ingestion, extraction, reconcile.
- **external-requests** — inbound request handling.

### CRM / Loyalty / Growth
- **crm** (`/api/crm`), **loyalty** (`/api/loyalty`), **metrika** (Yandex Metrika),
  **daily-digest**.

### Email / Chat
- **email** (`/api/email`), **email-tasks** (`/api/email-tasks`), **chat**
  (`/api/chat` — das-kompanion assistant).

### Ops modules
- **planner** (`/api/planner`) — procurement planner.
- **freight-rfq** (`/api/freight-rfq`), **skills** (`/api/skills`),
  **integrations** (`/api/integrations`).

### Auth / Admin / Health
- **auth** (`/api/auth`), **activity** (`/api/activity`).
- **admin-migrations** (`/admin`), **admin-auto-heal**, **admin-resync-prices**.
- **health** (`/health`), plus root `/api/_llm-diag` and `/api/cron/auto-delivery`.

## Backend — embedded skill engines (`api/src/skills/`)

- **invoicer/** — `data-loader`, `selectors`, `validators`, `types`, and
  renderers: `ci` (Commercial Invoice), `pl` (Packing List), `is-variant1/2`
  (Invoice/Specification), `tn` (Транспортная накладная), `upd` (УПД), `i18n`,
  `shared`. This is the parallel-chat territory.
- **freight-rfq/** — `index`, `renderer`, `types`.

## Backend — libraries (`api/src/lib/`, 53 files)

Notable: `anthropic` / `deepseek` / `gemini` / `openai-codex` / `qwen` / `llm`
(the multi-provider LLM routing), `bank-auto-match` / `bank-tx-allocator` /
`transaction-classifier` (banking brains), `inbox-auto-match` /
`inbox-ingestion` / `inbox-ingestion-telegram` / `inbox-reconcile` (inbox
pipeline), `marketplace-fifo-allocator` / `marketplace-match` /
`marketplace-pull` (marketplace ETL), `review-master-pipeline` / `wb-reviews` /
`wb-reviews-knowledge` (reviews AI), `auto-healer` / `healer-actions` /
`watchdog` / `integration-health` (self-healing), `loyalty`, `fx-cbr` /
`fx-store`, `md-to-docx`, `verification-pipeline`, `yandex-pay-sale`.

## Frontend — UI pages (`web/app/`, 41 pages)

- **Home / Pulse** (`/`) — daily digest, marketplace-first.
- **Operations** — list, `new`, `[id]`, `batch/[id]`, `bundling/new`,
  `[id]/freight-rfq` (+ `add-shipper`).
- **Partners** — list, `new`, `[slug]` hub, `edit`, `contracts` (`new`, `[id]`),
  `operations` (`new`, `[id]`), `payments/new`.
- **Products** — list, `new`, `[id]`.
- **Warehouses** — list, `[slug]`, `adjust`, `receipt`, `recount`,
  `sessions/new`.
- **Marketplaces**, **Reviews**, **CRM**, **Analytics**, **Finance**,
  **Planner**, **Emailer**.
- **Inbox** — `documents`, `documents/[id]`.
- **Settings** — root, `users`, `activity`, `finance-categories`, `finance-rules`.
- **Login**.

## Frontend — component groups (`web/components/`, 30 files)

`banking/`, `das-kompanion/` (chat), `emailer/`, `home/` (Pulse), `layout/`
(nav/shell), `operations/`, `products-partners/`, `reviews/`, `warehouses/`,
`ui/` (shadcn primitives).

## Data layer — D1 `das_erp_dev`

**`schema.ts` (Drizzle) defines 19 tables:** companies, company_bank_accounts,
manufacturers, manufacturer_bank_routes, price_types, products, product_prices,
partners, warehouses, shippers, operations, line_items, documents, stocks,
inventory_sessions, inventory_items, sequences, fx_rates, user_activity.

**Live D1 additionally carries tables created by later migrations** (not yet
back-ported into `schema.ts` — see MIGRATIONS.md): `contracts`, `invoice_inbox`,
`loyalty_accounts` / `loyalty_transactions` / `loyalty_webhook_log` /
`loyalty_redemptions`, `email_rules` / `email_tasks` / `email_canon` /
`email_classifications`, `planner_runs`, `agent_settlements`,
`bank_statement_files` + bank transaction/match tables, `users` + sessions, plus
audit views (`v_money`, `v_operation_payment_status`, `v_health`).

Layer boundary (ADR 001): reference tables sync daily from skills; operational
tables are edited only inside the ERP; PDFs/binaries live in R2, never D1.

## Storage & compute

- **R2:** `das-erp-docs-dev` (invoices, contracts, packing lists, product
  photos, email-canon), `das-pricelists` (price-list files).
- **KV:** `das-counters` (sequential numbers), `das-fx` (daily FX), `das-cache`
  (short-TTL caching).
- **Cron (Worker):** daily FX refresh (12:00 UTC), Ozon Performance CPC sync
  (`5 */6 * * *`), marketplace feeds refresh (every 6h), Telegram inbox
  (every 15 min), watchdog (every 10 min), inbox-reconcile (nightly), WB review
  reply drain (hourly), auto-delivery.
- **Shared workers:** `emailer-bridge` (outbound + Apps Script proxy),
  `apify-bridge` (scraping).

For account IDs, D1 UUID, deploy protocol and token inventory see
[`INFRASTRUCTURE.md`](./INFRASTRUCTURE.md).
