# FBO supply law — Ozon and WB

**Code:** `api/src/marketplaces/fbo-calc.ts`  
**Screen:** `/marketplaces`  
**Owner 2026-08-23** (stop 90 → 60). Replenish target unchanged from 2026-07-04.

Ozon and Wildberries share one calculator. One law.

## Two numbers — do not mix them

| | Days | What it does |
|---|---:|---|
| **Replenish** | **15** | If a cluster is empty or thin, fill it up to two weeks of *that cluster’s* sales. Cluster already holding ≥15 days → ship 0. |
| **Global stop** | **60** | If the SKU’s network stock ÷ 30-day sales **> 2** (more than 60 days), ship **nowhere** — not even into local stockouts. Auto-releases when the pile sells down. |

What is sitting on shelves today (often 50–60 days of adult paste) is inventory, not the target. The calculator does not drain a fat cluster down to 15. It only stops adding.

## Global stop is per SKU, not per family

A country-wide average of 50–60 days on adult pastes does **not** stop DETOX at 55 days or innoWeiss at 34. The gate fires on **that article**. Old gate was 90 days (`K_GLOBAL_STOP = 3.0`). New gate is 60 days (`K_GLOBAL_STOP = 2.0`).

## Cartons

Same 15-day fill for pastes, brushes, and floss. Rounding only differs:

- paste set (`de2##` + suffix) — 36
- paste single — 72
- brush/floss set — 144
- brush/floss single — 288

## What this is not

- Not 30-day cover (that is a separate cut of live Ozon *applications*, not this calculator).
- Not 60-day *replenish*. 60 is the **stop**, 15 is the **fill**.
- Not “move stock from fat cluster to thin one”. Local holes wait until the global pile is under 60 days.

## History

- 2026-07-04 — fill 36–60 days (`boost`) replaced with 15 days; global stop introduced at 90 days.
- 2026-08-23 — global stop shortened 90 → 60. Owner: *эти 90+ нам надо укоротить до 60*.
