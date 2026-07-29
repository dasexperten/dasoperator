# Planner allocation law + open repairs — 2026-07-29

**SSOT:** `dasexperten/organizacia` — `docs/CONTAINER_PLANNING_FORMAT.md` (`5543103`)
and `docs/AUDITS/2026-07-29_WAREHOUSE-MOVEMENTS-AUDIT.md` (`ba217ef`).
This file is the code-side copy. If the two disagree, organizacia wins.

**Owner 2026-07-29.** Files touched by this order: `api/src/routes/planner.ts`,
`web/app/planner/page.tsx`, `api/src/routes/external-requests.ts`.

---

## Order of work — not negotiable

**Importer first, planner second.** A corrected allocator fed by frozen stock will faithfully
distribute a container across false inputs. The importer is built and forward-only —
it stops accumulation, it does not replay history. See §1.

---

## 1 — Skladbot importer — BUILT 2026-07-29

`8da4632` (build) · `eb79e21` (floor guard). Shipped to `main`, **not deployed**.

The mirror (`/sync`) was always healthy and on cron. What did not exist:
`mp_delivery` had a hand-run endpoint capped at 30 rows a call, and `acceptance` /
`writeoff` had **no import path at any point** — hence every one unposted since 2025-09.

Built: `POST /api/external-requests/import` for acceptance (receipt, `accepted_amount`)
and writeoff (`write_off`), mp_delivery cap 30 → 500, both on the f4-sync cron,
movements through `applyMovement` so the sign rules are enforced. `?dry=1` plans only.

### Do NOT backfill the 135

A dry run against prod D1 found 389 355 units of acceptance and 175 629 of write-off
dated below the opening balance, and everything up to 2026-07-15 already absorbed by the
committed LBR inventory session. Posting would have taken LBR from ~145 573 past 400 000.

**Floor rule, now in code:** a warehouse is truth as of its last committed inventory
session; requests at or before that timestamp are absorbed by definition. The floor is read
from `inventory_sessions` per run, falling back to the opening balance for a warehouse never
counted. Backfill logic deleted with it — **forward-only**.

Above the floor today: acceptance 0 · writeoff 0 · mp_delivery 1 request / 15 units.

## 2 — Backfill 13 sales

Sitting at `delivered` with no movements — inserted straight into D1, so no status transition
can ever fire. Distinct from the 33 stuck at `issued`, which repair themselves when someone
advances the status in the UI.

## 3 — Sign convention

`stock_movements.transfer_out` is stored negative from source `manual` and positive from
source `operation`. One column, two conventions.

---

## 4 — Planner allocation

**Principle.** Every position in a container order arrives with the **same days of cover**.
The container fixes volume; the level is solved for it.

| Mode | Fixed | Solved for |
|---|---|---|
| Natural reorder | L = 90 d | volume |
| 20FT | 28 m³ | L |
| 40HQ | 76 m³ | L |

**Law of the lock.** A hand-entered number is frozen and never recalculated — **including zero**.
A manual zero is a decision not to order. Locked rows are subtracted from capacity **before**
the level search; the rest divide the remainder.

**Need**
```
need = velocity × (L + 70) − stock
```
L is measured **at arrival** — the lead time sits inside the bracket because stock keeps
depleting in transit.

**Thresholds**
```
need < 9 000            → not included
9 000 ≤ need < 10 800   → round up to 10 800
need ≥ 10 800           → take need, rounded up to whole cartons
```

**Level search.** Raise L until volume meets capacity; take the largest L that still fits.
Leftover cartons go to the lowest-cover position. Binary search, monotone, deterministic.

**Delete**
- `score = velocity^1.5 / coverAfter` and the whole ranked queue
- tier ladders `365/545/730/910/1095` and `540/730/910/1095/1280`
- whole-MOQ entry ticket for un-picked positions
- backend scenario stubs — `20ft` is a copy of pallet figures, `40ft` multiplies everything by 2
- `FORTYFT_THRESHOLD = 1.2` — replaced by demand: if positions below the critical floor do not
  fit 20FT, recommend 40HQ

**Reconcile.** `CONTAINER_40FT_M3 = 56` (backend) vs `C40_VOLUME_M3 = 76` (frontend).
76 is correct for High Cube. One SSOT.

**Split brain.** Backend computes need, frontend discards it and refills with its own rules.
One calculation, one place.

**Surface the level** next to fill % — `level 248 d`. Half the distrust in the planner comes
from the rule being invisible.

**`flp` out of `BUNDLABLE_WH`.** Owner 2026-07-29: we do not work with FlyPost.
Bundling can currently borrow donor pieces from a warehouse holding nothing.

---

## Verification — ship as a unit test (CI runs `*.test.mjs`)

Honghui group, data of 2026-07-29.

**20FT · level 248 d · 1 296 cartons · 27.99 m³**

| SKU | Cartons | Units | Days at arrival |
|---|---|---|---|
| DE202 DETOX | 560 | 40 320 | 248 |
| DE203 GINGER FORCE | 328 | 23 616 | 248 |
| DE210 INNOWEISS | 237 | 17 064 | 248 |
| DE208 EVOLUTION | 168 | 12 096 | 248 |

**40HQ · level 455 d · 3 519 cartons · 76.0 m³**

| SKU | Cartons | Units | Days at arrival |
|---|---|---|---|
| DE202 DETOX | 1 181 | 85 032 | 456 |
| DE203 GINGER FORCE | 688 | 49 536 | 455 |
| DE206 SYMBIOS | 482 | 34 704 | 455 |
| DE210 INNOWEISS | 459 | 33 048 | 455 |
| DE208 EVOLUTION | 368 | 26 496 | 455 |
| DE205 COCOCANNABIS | 343 | 24 696 | 455 |

---

## Not code — flagged for the Owner

LBR inventory session `ses_9fbd80d5` has been `open` since 2026-05-05. Close or cancel before
any repair lands; an open session can apply retroactively.

WB and Ozon rows in `stocks` are orphans from a manual 2026-05-15 entry, predating the
2026-07-21 pull-ownership law. Nothing writes to them. Retire them — mark non-authoritative,
do not delete. Do **not** mirror `marketplace_stocks_*` into `stocks`: a second copy of one
number re-opens the same drift.
