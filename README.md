# Das Operator ERP

Cloudflare-native ERP system for Das Experten International.

**Stack:** D1 + R2 + KV + Workers + Hono + Next.js 14 + Drizzle + shadcn/ui + Tremor

## Status
Phase 1.0 — repository skeleton (in progress).

## Structure
- `api/` — Cloudflare Workers backend (Hono)
- `web/` — Next.js 14 frontend on Cloudflare Pages
- `db/` — Drizzle schema and D1 migrations
- `docs/` — architecture and decision records

See `docs/architecture.md` for details.

## Domain
- Development: auto `*.pages.dev` (Cloudflare Pages git integration)
- Production: `erp.dasexperten.com` (deferred)
