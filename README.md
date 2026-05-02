# Das Operator ERP

Cloudflare-native ERP system for Das Experten International.

**Stack:** D1 + R2 + KV + Workers + Hono + Next.js 14 + Drizzle + shadcn/ui + Tremor

## Status

| Phase | Description | Status |
|---|---|---|
| 1.0 | Repository skeleton (api / web / db / docs) | Done |
| 1.0a | Cloudflare Pages Static Export fix | Done |
| 1.1 | D1 schema initial migration (16 tables) | In review |
| 1.2 | Reference data seed (companies, partners, products) | Planned |
| 1.3 | R2 bucket + KV namespace setup | Planned |
| 2.0 | Skills bridge (8 HTTP endpoints) | Planned |
| 3.0 | UI shell (dashboards, forms) | Planned |

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
