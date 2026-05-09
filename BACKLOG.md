# Das Operator ERP — Backlog

Single source of truth for outstanding work. Updated as items are picked up
or completed. Newest decisions go to the top of each section.

Last reviewed: 2026-05-09

---

## Now / next up

These are the next items in line. Pick by saying the letter (A, B, C…).

**A — Static Export 404 fix** (blocker)
Architectural problem: Next.js builds detail pages from a hardcoded list at
build time. Any new product, partner, operation created via the UI returns
404 on its detail URL until the next deploy.
*Affects:* clicking SKU on /marketplaces, opening any new operation,
opening any new partner, opening any new product.
*Solution direction:* drop `output: "export"` and switch to SSR via
Cloudflare Workers runtime (Pages adapter), OR add SPA-fallback route that
fetches data dynamically. Previous SPA-fallback attempt broke list pages —
needs careful re-attempt.
Estimated 2–3 hours.

**B — Top customers leaderboard widget on /crm**
Top 10 spenders, after the Daily activity chart, before the tabs. Lists
name + total spent + orders count. Click goes to customer detail (only
useful once A is fixed). Without click — still useful as a glance card.
Estimated 30 min.

**C — Operation detail page**
URL `/partners/[slug]/operations/[id]` — currently links there but page
doesn't exist. Needs: header (ref + date + status with payment overlay),
line items table, payments table, stock movements, FX snapshot. All data
already in API.
Depends on A being resolved.
Estimated 1 hour.

**D — Operation status update from UI**
Buttons on operation detail page: "Mark as issued" / "Mark as shipped" /
"Mark as delivered". Backend endpoint already exists
(PATCH /api/operations/:id/status). Without this only curl can advance.
Depends on C.
Estimated 30 min.

---

## Started but not finished

**E — Payment overlay on partner hub Operations card**
/operations top-level page already shows payment dot+pct overlay. The
same operations table embedded on /partners/[slug] does not. Mirror the
pattern.
Estimated 30 min.

**F — Documents tab UI on operation detail**
Endpoint `/api/operations/:id/documents` is live (PR #48). The UI tab
that would show CI / PL / IS docs on the operation card is not wired.
Depends on C.
Estimated 1 hour.

**G — CRM page polish**
- Tooltip already moved below chart (done).
- Loyalty funnel widget (done).
- Top customers widget — see B above.

---

## Big unfinished phases

**H — Phase 5.4 step 5: Products edit + create**
- PUT /api/products/:id (update)
- POST /api/products (create new SKU)
- Add product form on /products
- Inline edit mode on /products/[id]
- Add price button is wired; product fields aren't.
Estimated 2–3 hours.

**I — Phase 4.5: Inventory action forms**
- /warehouses/[slug]/sessions/new — Start Session wizard
- /warehouses/[slug]/adjust — Adjust Stock form
- /warehouses/[slug]/receipt — Receipt form
- /warehouses/[slug]/recount — Recount form
Buttons currently route to placeholders.
Estimated 2–3 hours.

**J — Phase 5.5: Photo polish**
- Image cropping in upload UI
- Drag-to-reorder photos
- Thumbnail generation
Estimated 1–2 hours.

---

## Banking integrations (Phase 7.x)

**K — VTB integration**
Read-only API requires УНЭП (electronic signature) on every call.
Cannot run on Cloudflare Workers. Recommended approach: manual CSV import
from VTB Business Platform. 1С DirectBank exists but only for 1С users.

**L — Wio Bank API**
Two accounts (AED + USD) for DEI. API access request sent 2026-05-08.
Awaiting bank approval. Manual entry until then.

---

## Production hardening

**M — Cloudflare Access SSO**
Public UI/API → SSO protected. Defer until business expansion warrants.
Currently anyone with the URL can read the ERP.

**N — Investigate CF Pages git-trigger reliability**
Some git pushes show "success" in CF Pages dashboard but serve stale HTML
(chunk filenames don't exist on CDN). Workaround: direct wrangler CLI
upload. Possibly worth a Cloudflare support ticket with deploy IDs.

**O — Phase 5.5 cosmetic refactor (~30 min)**
Rename legacy variables: balance_minor / paidMinor / usdCents → balance /
paid / usd. Names are stale after decimal money migration; values correct.

---

## Latent issues (not blockers)

- DEE-007 stocks.on_hand = -240 (negative) — expected from earlier
  ship-without-opening test
- 3 old line_items rows from PR-C2 smoke test reference non-existent
  prd_de101 (hidden, not breaking)
- /api/products/lookup endpoint searches column 'sku' that doesn't exist
  (real column is 'id'). Returns 0 for any query. Owned by parallel chat.
- 41 placeholder contract IDs (e.g. `placeholder_xxx_yyy_001`) still in
  contracts table — could be normalized to follow real ID format. ~30 min.

---

## Done in recent sessions (reference, not action)

**2026-05-09**
- Ozon Performance API CPC sync fix (404 → /v3/product/list)
- Partner abbreviations seed (70/70 unique)
- Real contracts seeded from Drive Agreements folder (9 new + 11 existing)
- Warehouse han→swh rename
- F4 Lubertsy contract №9 + addendum №1 from PDFs
- Currency rule fix: DEE↔Chinese factory = CNY (was USD)
- Partners list endpoint fix (LEFT JOIN active main contract)
- Sidebar Contracts removed
- New CRM page with Retail CRM v5 integration
  - KPI tiles (5 → 6 with Visits today)
  - Orders + Customers tabs with pagination, search, page size
  - Loyalty bonuses display: Credited / Charged / Level / Balance columns
- Yandex Metrika integration (counter 107720199)
- Daily activity chart — 30 days, 3 layers (visits / regs / orders)
  - Interactive hover with day inspector below chart
- Loyalty conversion funnel widget
- Legacy Yandex KIT customers (912 rows) imported to D1, then UI tab
  removed — kept in DB for reference

---

## Decision log shortcuts

When picking up an item from this list:
1. Start the next chat with: `продолжаем Das Operator ERP — пункт <letter>`
2. The `BACKLOG.md` lives in repo root — always reflects current state
3. After completion, move item to "Done" section + bump session date
