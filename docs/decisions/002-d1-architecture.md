# ADR 002 — D1 Schema Architectural Conventions

**Status:** Accepted
**Date:** 2026-05-02
**Decision maker:** Aram Badalyan (delegated to Claude on architectural specifics)

## Context

Phase 1.1 creates the operational schema for Das Operator ERP in
Cloudflare D1. The schema covers 16 tables across reference data,
operations, documents, inventory, and system counters.

Several technical decisions affect every table and every query in the
codebase. These were resolved during Phase 1.1 planning. This document
records them so future contributors understand the why, not just the what.

## Decisions

### 1. Primary keys are TEXT slugs, not autoincrement integers

Example: `companies.id = 'cmp_dee'`, `partners.id = 'prt_torwey'`,
`products.id = 'DE201'`.

**Why:** Slugs are readable in raw SQL queries, portable across
environments (dev to staging to prod), and consistent with the skills
layer where data lives in markdown files like `contacts/buyers/torwey.md`.
Numeric IDs require lookup tables for human readability and break when
data is exported and reimported.

### 2. Money stored as INTEGER in minor units (kopecks, cents)

Example: 890.00 RUB is stored as `89000`. UI divides by 100.

**Why:** Floating point arithmetic is unreliable for financial data —
0.1 + 0.2 returns 0.30000000000000004 in any IEEE 754 system including
SQLite. Industry standard (Stripe, banks, all serious payment systems)
is to store money as integers in the smallest unit of the currency.

### 3. Dates stored as INTEGER unix timestamps

Example: `2024-01-15` is stored as `1705276800`.

**Why:** Sort order matches chronological order automatically. Format
independence — no parsing edge cases between MM/DD and DD/MM. Math
operations like date arithmetic are trivial. Timezone is always UTC by
convention; conversion to local time happens at the UI layer.

### 4. FX rates stored as INTEGER × 1,000,000

Example: 1 USD = 0.918765 EUR is stored as `918765` (multiplier 1,000,000).

**Why:** Same precision argument as money. FX rates need 6+ decimal
places of precision for accurate conversion of large amounts; storing
as multiplied integer preserves precision without floating point.

### 5. Soft delete via `deleted_at` column

All operational tables have `deleted_at INTEGER NULL`. Records are never
physically deleted; instead `UPDATE table SET deleted_at = unix_now()`.

**Why:** ERP audit trail requires preservation of historical records.
A deleted Partner that had Operations against it must remain readable
in historical reports. Physical DELETE breaks foreign key chains and
loses information forever.

### 6. All tables have `created_at` and `updated_at`

Both as INTEGER unix timestamps. `created_at` is set on INSERT,
`updated_at` is set on every UPDATE (managed by application code or
triggers).

**Why:** Standard practice. Required for change tracking, sync logic
(skill markdown files into D1), and debugging.

### 7. Foreign keys use ON DELETE RESTRICT by default

Two exceptions where ON DELETE CASCADE is appropriate:
- `line_items` → `operations` (deleting an operation removes its lines)
- `inventory_items` → `inventory_sessions` (same logic)

**Why:** RESTRICT is the safer default. Accidental deletion of a Company
should not cascade-delete every related Operation and Line Item.
CASCADE only for clear parent-child relationships where the child has
no meaning without the parent.

### 8. Status and Type enums use TEXT + CHECK constraints

Example: `status TEXT NOT NULL CHECK (status IN ('draft', 'shipped', 'delivered', 'cancelled'))`

**Why:** Faster than separate enum tables (no JOIN required). Drizzle
ORM provides full TypeScript type safety for these constraints. Schema
changes (adding a new status) require a single ALTER TABLE statement.

### 9. Flexible attributes stored as JSON in TEXT field

Example: `documents.metadata` may contain `{"hsCode": "3306.10.00", "weight": 1200}`.

**Why:** SQLite has native JSON functions (`json_extract`, `json_set`)
that allow querying inside JSON fields. Avoids creating dozens of
nullable columns for rarely-used attributes. Trade-off: cannot index
inside JSON, so frequently-queried fields should be promoted to real
columns.

## Consequences

### Positive

- **Type-safe** via Drizzle ORM — TypeScript catches schema mismatches at compile time
- **Audit trail** preserved through soft delete + timestamps
- **Currency-safe** — no floating point arithmetic for money or FX
- **Performant** — proper indexes on FK columns, date columns, status fields
- **Portable** — slug IDs survive data export and reimport
- **Self-documenting** — CHECK constraints embed business rules in the schema

### Negative

- **UI conversion overhead** — divide money by 100, format unix timestamps
- **No native bool type** — must use INTEGER 0/1 (SQLite limitation)
- **Manual schema sync** — `schema.ts` and `migrations/*.sql` must be kept in sync by hand until drizzle-kit is fully integrated in Phase 2

## Migration strategy

Schema changes follow numbered migration files:
- `migrations/0001_init.sql` — Phase 1.1 initial schema
- `migrations/0002_*.sql` — future changes
- `migrations/0003_*.sql` — etc.

Each migration is applied in order via D1 Console (Phase 1) or wrangler
CLI (Phase 2+). Migrations are append-only — never edit a migration
that has been applied to production.

## Alternatives considered and rejected

### Alternative: numeric autoincrement primary keys

Rejected because of poor readability in raw SQL and breaking changes on
data export/import cycles.

### Alternative: separate enum tables (status_types, document_types)

Rejected due to JOIN overhead on every read query. CHECK constraints
provide the same data integrity with better performance.

### Alternative: TIMESTAMP / DATE column types

SQLite does not have native date types — TIMESTAMP is just an alias for
TEXT. Storing as INTEGER unix timestamps is the canonical SQLite approach.

### Alternative: REAL columns for money

Rejected due to floating point precision issues. Industry standard
is integer minor units.

## Related documents

- `db/README.md` — practical reference for the schema
- `db/schema.ts` — source of truth for application code
- `db/migrations/0001_init.sql` — initial migration
- `docs/architecture.md` — overall ERP architecture
- `docs/decisions/001-d1-vs-skills.md` — D1 vs skills boundary
