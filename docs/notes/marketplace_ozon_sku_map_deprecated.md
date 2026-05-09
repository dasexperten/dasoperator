# `marketplace_ozon_sku_map` — DEPRECATED

**Status:** Empty (0 rows), unused in code, kept for reference.
**Discovered:** 2026-05-09 during cleanup pass.

## Schema

```sql
CREATE TABLE marketplace_ozon_sku_map (
  ozon_sku    INTEGER PRIMARY KEY,
  offer_id    TEXT,
  product_id  TEXT,
  base_sku    TEXT,
  pack_factor INTEGER,
  synced_at   INTEGER
);
CREATE INDEX idx_ozon_sku_map_base_sku ON marketplace_ozon_sku_map(base_sku);
```

## Why it was created

Originally intended as a persistent SKU map between Ozon's internal
`ozon_sku` numbers and our `product_id`. The idea was that
`scheduled.refreshOzonSkuMap()` would write to it, and other code
would read from it for joins.

## What actually happened

The schedule function returns a `Map<number, any>` **in-memory** —
the table is never written to. Other code paths (e.g. CPC join in
`marketplace_sales_ozon`) build the mapping on the fly per request.

Migration to `/v3/product/list` (2026-05-09) confirmed: SKU map is
session-scoped, not persistent.

## Recommended action

**Option A — Remove entirely:**
```sql
DROP INDEX IF EXISTS idx_ozon_sku_map_base_sku;
DROP TABLE IF EXISTS marketplace_ozon_sku_map;
```
Safe — no code reads or writes it.

**Option B — Repurpose (if persistence is needed):**
Wire `refreshOzonSkuMap()` to also UPSERT each row into the table,
add `WHERE updated_at >= ?` indexed lookup, drop in-memory map.
Useful only if API rate limits or cold-start latency become a
concern. Currently neither does — keep deferred.

Until either is decided, this table is fossilized noise. Not a bug,
not a blocker, just clutter.
