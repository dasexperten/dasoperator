# Das Operator ERP — Architecture Overview

## Stack

| Layer | Technology |
|---|---|
| Database | Cloudflare D1 (SQLite serverless) |
| ORM | Drizzle (TypeScript) |
| File storage | Cloudflare R2 |
| Cache / counters | Cloudflare KV |
| Background jobs | Cloudflare Queues |
| Backend API | Cloudflare Workers + Hono |
| Frontend | Next.js 14 on Cloudflare Pages |
| UI kit | shadcn/ui + Tailwind + Tremor |
| Authentication | Cloudflare Access |
| Email | Existing emailer-bridge worker |
| Web scraping | Existing apify-bridge worker |

## Repository structure

dasoperator/
- api/    Cloudflare Workers (Hono backend)
- web/    Next.js 14 frontend on Cloudflare Pages
- db/     Drizzle schema and D1 migrations
- docs/   Architecture, decisions, runbooks

## Data architecture

D1 is the operational source of truth for ERP data (operations, line items,
documents, stocks, inventory). Skills (contacts, product-skill, pricer,
invoicer, legalizer, logist) provide knowledge layer and business logic;
their reference data is synchronized into D1 daily via a background worker.

See docs/decisions/001-d1-vs-skills.md for the detailed boundary.

## Skills as ERP modules

Each Das Experten skill becomes an HTTP endpoint inside the Workers API.
The ERP UI calls these endpoints; the same skills remain available via the
Claude chat interface for ad-hoc operations.

| Skill | ERP endpoint |
|---|---|
| product-skill | /api/products/lookup |
| contacts | /api/contacts/:slug |
| pricer | /api/pricer/quote |
| invoicer | /api/documents/issue |
| legalizer | /api/legal/check |
| logist | /api/shipments/scheme |
| emailer | /api/email/send |
| apifier | /api/apify/run |

## Domain plan

- Development: auto `*.pages.dev` from Cloudflare Pages git integration
- Production: erp.dasexperten.com (deferred)

## Cloudflare resources

- Account ID: 081ddb85cb399ad62a70210328d744fc
- Plan: Workers Paid
- Shared workers (existing): emailer-bridge, apify-bridge
