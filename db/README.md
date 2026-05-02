# Das Operator — D1 Database Schema

## Database

- Name: `das_erp_dev`
- ID: `0653d156-5069-4c46-a496-fad982d0d1df`
- Region: East Europe (EEUR)
- Plan: Cloudflare D1 (SQLite serverless)
- Worker binding: `env.DB`

## Tables (16)

### Reference layer
Synchronized daily from Das Experten skills (contacts, product-skill, pricer, logist).

| Table | Purpose | Source |
|---|---|---|
| `companies` | Our legal entities | contacts/das-group |
| `manufacturers` | Production partners | product-skill MANUFACTURING |
| `price_types` | Pricing categories | manual seed |
| `products` | SKU catalog | product-skill sku-data |
| `product_prices` | Junction SKU x PriceType | pricer |
| `partners` | Buyers, suppliers, shippers | contacts/buyers + contacts/logistics |
| `warehouses` | Storage locations | logist warehouse codes |
| `shippers` | Logistics providers | logist/shippers/INDEX |

### Operational layer
Created and edited inside the ERP UI. Never synced from skills.

| Table | Purpose |
|---|---|
| `operations` | Sale / Purchase / Transfer transactions |
| `line_items` | SKU rows inside an operation |
| `documents` | Registry of CI / PL / IS / contracts |
| `stocks` | Current stock per SKU per warehouse |
| `inventory_sessions` | Stocktaking sessions |
| `inventory_items` | Counted positions per session |

### System layer

| Table | Purpose |
|---|---|
| `sequences` | Counters for DEI-001, CI-202605-0001 |
| `fx_rates` | Daily FX rates from CBR / ECB |

## Architectural conventions

See `docs/decisions/002-d1-architecture.md` for full rationale.

- **Primary keys** are TEXT slugs (e.g. `cmp_dee`, `prt_torwey`, `prd_de201`)
- **Money** is stored as INTEGER in minor units — divide by 100 on UI
- **Dates** are INTEGER unix timestamps — convert to readable on UI
- **FX rates** are INTEGER multiplied by 1,000,000 for precision
- **Soft delete** via `deleted_at` field (not physical DELETE)
- **All tables** have `created_at` and `updated_at`
- **FK constraints** use `ON DELETE RESTRICT` by default
- **Status / Type enums** use TEXT with CHECK constraints
- **Flexible attributes** stored as JSON in TEXT (e.g. `documents.metadata`)

## How to apply migrations

Migrations are stored in `migrations/` folder as plain `.sql` files.
File naming: `NNNN_description.sql` (e.g. `0001_init.sql`).

### Manual application via Cloudflare D1 Console (current method, Phase 1.1)

1. Open `dash.cloudflare.com` → Workers and Pages → D1 → `das_erp_dev`
2. Click the Console tab
3. Open the migration file (e.g. `migrations/0001_init.sql`)
4. Copy entire contents and paste into the Console editor
5. Click Execute
6. Verify tables created:
```sql
   SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
```
   Expected: 16 rows.

### Automated application via wrangler CLI (Phase 2+)

Once wrangler CLI is set up locally:

```
cd db
npm install
wrangler d1 migrations apply das_erp_dev --remote
```

This requires `wrangler.toml` to point to the database, which is already
configured in `api/wrangler.toml`.

## Schema as code (Drizzle ORM)

The TypeScript representation of the schema lives in `schema.ts`.
This file is the source of truth for application code — Workers
import types from here for compile-time safety.

The `.sql` migrations and `schema.ts` are kept in sync manually.
When schema changes, both files must be updated in the same PR.

## Sequences seed

After running `0001_init.sql`, the `sequences` table is empty.
The seed for entity counters (DEE, DEI, DEASEAN, DEC) and document
counters (CI, PL) will be applied in Phase 1.2 along with reference
data import.
