# Das Operator ERP

Cloudflare-native ERP system for Das Experten International.

**Stack:** D1 + R2 + KV + Workers + Hono + Next.js 14 + Drizzle + shadcn/ui + Tremor

## Status

**Live in production.** Worker `dasoperator-api.dasexperten.workers.dev` +
frontend `dasoperator.pages.dev` on D1 `das_erp_dev`. The system spans
60 migrations, 65 API route modules, 41 UI pages, and phases 1.0 → 10.1.

| Phase | Description | Status |
|---|---|---|
| 1.x | Skeleton, D1 schema, reference seed | Done |
| 2.x | Operations, contracts, payments, invoicer foundation | Done |
| 3.x | UI shell, documents hardening, delivery status, RFQ, OTW | Live |
| 4.x | Inventory module (action forms partial) | Live |
| 5.x | Products, images (edit/create + photo polish open) | Live |
| 6.x | Marketplaces — Ozon/WB stocks, sales, CPC, reviews/questions | Live |
| 7.x | Contracts registry, R2 files, banking (Modulbank), settlements | Live |
| 8.x | Real contracts, warehouse normalization, CRM legacy import | Done |
| 9.x | Email-to-Operation / Invoice Inbox (Gmail + Telegram) | Live |
| 10.x | Loyalty Engine «Клуб Экспертов» (RetailCRM replacement) | Done |

Full phase detail and status → [`HISTORY/PHASES.md`](HISTORY/PHASES.md).
Open items → [`BACKLOG.md`](BACKLOG.md).

## Project history

The complete record of everything built, decided, and deployed lives in
[`HISTORY/`](HISTORY/) — a reconstructed event database:

- [`HISTORY/EVENTS.md`](HISTORY/EVENTS.md) — master chronological log (2026-05-02 → today)
- [`HISTORY/events.csv`](HISTORY/events.csv) — machine-readable event table
- [`HISTORY/MIGRATIONS.md`](HISTORY/MIGRATIONS.md) — annotated ledger of all 60 migrations
- [`HISTORY/SYSTEM-INVENTORY.md`](HISTORY/SYSTEM-INVENTORY.md) — every module / route / page / table
- [`HISTORY/DECISIONS.md`](HISTORY/DECISIONS.md) — decisions + cemented business rules
- [`HISTORY/INFRASTRUCTURE.md`](HISTORY/INFRASTRUCTURE.md) — infra, integrations, deploy protocol
- [`HISTORY/sessions/`](HISTORY/sessions/) — end-of-session records + session index

## Structure

```
dasoperator/
  api/        — Cloudflare Workers backend (Hono)
  web/        — Next.js 14 frontend on Cloudflare Pages
  db/         — Drizzle schema + D1 migrations
  docs/       — Architecture, ADRs, runbooks
```

## Quick references

- **Repository:** `github.com/dasexperten/dasoperator`
- **Production URL:** `dasoperator.pages.dev` (auto-deploy from main)
- **Future custom domain:** `erp.dasexperten.com` (deferred)
- **Architecture overview:** `docs/architecture.md`
- **Schema documentation:** `db/README.md`

## Decision records

- ADR 001 — D1 vs Skills as Source of Truth
- ADR 002 — D1 Schema Architectural Conventions

Located in `docs/decisions/`.

## Cloudflare resources

- Account ID: `081ddb85cb399ad62a70210328d744fc`
- Plan: Workers Paid
- D1 database: `das_erp_dev` (East Europe)
- Shared workers: `emailer-bridge`, `apify-bridge`
