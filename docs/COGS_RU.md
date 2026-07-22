# COGS-RU — Russia landed cost price type

**Owners:** Justina (finance) + Zina (logistics)  
**Price type id:** `cogs_ru`  
**Code:** `COGS-RU`  
**Currency:** RUB  
**Entity:** DEE  

Created Owner 2026-07-22 after Krasnodar stock fire valuation.

## What it is

Internal **себестоимость** for one **offer unit** as sold/stocked (однушка / двушка / четвёрка):

| Component | Rule |
|---|---|
| Factory | D1 `purchase_cny` → USD (preferred), else `export_usd` (Purchasing USD). If multipack has no own purchase row → base price × `bundle_size`. |
| Freight | Avg **$6 000** / 20' GP, 85% practical cube fill (Zina packing norms). |
| Duty | Pastes **6.5%**; brushes / floss / other **15%** on (factory + freight). |
| Honest Sign | **3 RUB** per physical paste tube (`bundle_size` tubes on multipacks). QR + China side + 1 RUB. |
| Import VAT 22% | **Not** in COGS (recoverable). |

`COGS-RU RUB = (factory_usd + freight_usd + duty_usd) × CBR RUB/USD + mark_rub`

## Multipacks

- **AA / 2in1** → `bundle_size = 2` → twice the single (if factory is per tube) or already multipack purchase price if stored on the multipack SKU.
- **AAAA / 4in1** → `bundle_size = 4` similarly.

## API

| Call | Purpose |
|---|---|
| `GET /api/price-types` | Lists `cogs_ru` |
| `GET /api/products/:id/price?price_type_id=cogs_ru` | One SKU COGS-RU |
| `GET /api/pricer/list/cogs_ru` | Full matrix |
| `POST /api/admin/cogs-ru/recompute` | Recompute all (`{ "apply": true }` or dry-run `apply:false`) |

## Migration

`db/migrations/0063_cogs_ru_price_type.sql` — inserts price type (idempotent).

## Code

- Formula: `api/src/lib/cogs-ru.ts`
- Recompute: `api/src/routes/admin-cogs-ru.ts`

## Gaps

SKUs without purchasing prices stay without COGS-RU until factory price is loaded (e.g. historically DE114, DE204).
