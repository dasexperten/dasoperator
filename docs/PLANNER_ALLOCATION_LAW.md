# Planner allocation law + open repairs — 2026-07-29

**SSOT:** `dasexperten/organizacia` — `docs/CONTAINER_PLANNING_FORMAT.md` (`5543103`)
and `docs/AUDITS/2026-07-29_WAREHOUSE-MOVEMENTS-AUDIT.md` (`ba217ef`).
This file is the code-side copy. If the two disagree, organizacia wins.

**Owner 2026-07-29.** Files touched by this order: `api/src/routes/planner.ts`,
`web/app/planner/page.tsx`, `api/src/routes/external-requests.ts`.

---

## Order of work — not negotiable

**Importer first, planner second.** A corrected allocator fed by frozen stock will faithfully
distribute a container across false inputs.

---

## 1 — Skladbot importer (dead since June)

`external_requests` syncs daily and is current. The import into operations is not.

| Month | Requests | Imported |
|---|---|---|
| 2026-04 | 46 | 36 |
| 2026-05 | 40 | 14 |
| 2026-06 | 46 | **0** |
| 2026-07 | 27 | **0** |

135 of 217 unposted. 72 `mp_delivery` = 76 025 units (2026-05-17 → 2026-07-27),
all 43 `acceptance`, all 18 `writeoff`.

Post **in chronological order** — the negative-stock guard rejects an outbound whose inbound
has not landed. The guard is correct; do not weaken it to force a backfill through.

Bundling arrives in the feed already: `bundling_divisor`, `bundling_from_qty`,
`bundling_to_qty` per item. Post it with its request.

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
