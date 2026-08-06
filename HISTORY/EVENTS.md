# Das Operator ERP — Master Event Log

> The full chronology of the project, reconstructed from every source.
> Grouped by date/window; each entry cites its source. For the
> machine-readable version see [`events.csv`](./events.csv).

**Span:** 2026-05-02 (first ADRs) → 2026-07-02 (latest commit at compile time).
**Compiled:** 2026-07-03.

Dating note: migrations 0017, 0019–0028, 0039–0040, 0050–0051 carry explicit
"applied to prod" dates; the rest are dated by phase sequence and the session
notes that describe them. Dates shown as *(window)* are inferred from ordering;
exact dates are stated plainly. Pre-2026-05-09 session notes are referenced in
the project memory but their full files did not survive into a repo — those
rows are marked *reconstructed*.

---

## Day 0 — 2026-05-02 · Foundations & architecture

The project opens not with code but with two architecture decision records,
both accepted by Aram on 2026-05-02.

- **ADR 001 — D1 vs Skills as source of truth.** Hybrid model chosen (Variant Z):
  D1 holds operational master data; the eight Das Experten skills remain the
  knowledge layer; reference data syncs daily into D1; PDFs live in R2, never
  in D1. *(source: docs/decisions/001)*
- **ADR 002 — D1 schema conventions.** Nine cross-cutting rules locked: TEXT
  slug primary keys, money as INTEGER minor units, dates as INTEGER unix
  timestamps, FX × 1,000,000, soft-delete via `deleted_at`, `created_at`/
  `updated_at` everywhere, FK `ON DELETE RESTRICT` by default, TEXT+CHECK enums,
  JSON in TEXT for flexible attributes. *(source: docs/decisions/002)*
- **CHECKPOINT 2026-05-02** session recorded. *(reconstructed — referenced in _PROJECT.md)*

**Project brief set:** a full Cloudflare-native ERP where the 8 skills
(product-skill, contacts, pricer, invoicer, legalizer, logist/logistics,
emailer, apifier) run as embedded business-logic modules inside Workers, with
Products / Partners / Operations / Documents / Stocks in D1, files in R2, UI on
Pages. *(source: _PROJECT.md, architecture.md)*

---

## Phase 1 — 2026-05-02 → 2026-05-03 · Skeleton & initial schema

- **Phase 1.0** — repository skeleton (`api/` `web/` `db/` `docs/`). Done. *(README)*
- **Phase 1.0a** — Cloudflare Pages Static Export fix (first deploy went live). Done. *(README)*
- **Phase 1.1** — initial D1 schema, **16 tables** across reference / operational
  / system layers. *(migration 0001)*
- **Phase 1.1 populate** — companies + sequences seed. *(migration 0003)*
- **Phase 1.2** — reference data seed (companies, partners, products). *(migration 0002)*
- **END OF DAY 2026-05-03** recorded. *(reconstructed)*

Legal-entity model established: **DEE** (ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ, Russia/VTB),
**DEI** (Das Experten International LLC, UAE/Sharjah), **DASEAN** (Vietnam),
**DEC** (holding only). Chinese manufacturers: Guangzhou Honghui Daily, Yangzhou
Jinxia, WDAA, Meizhiyuan (Honghui invoicing entity). *(source: _PROJECT.md)*

---

## Phase 2 — 2026-05-03 → 2026-05-05 *(window)* · Operations, contracts, invoicer foundation

- Operations gain a human **reference** column (`<PARTNERABBR>-YYMMDDXX`). *(migration 0004)*
- **Contracts** table + payment-markdown enhancements. *(migration 0005)*
- **Payments** table added; legacy `paid` columns cleaned up. *(migration 0006)*
- **Phase 2.0c — Invoicer foundation:** schema rewrite for the new invoicer
  engine. *(migration 0007)*, seed invoicer data — companies, manufacturers,
  products, partners, contracts + product-id rename *(migration 0008)*, invoicer
  roles + manufacturer bank routes + `seq_is` sequence *(migration 0009)*.
- **VAT rate** added to contracts and operations. *(migration 0010)*
- **END OF DAY 2026-05-04 / 2026-05-05** recorded. *(reconstructed)*

---

## Phases 4–6 — 2026-05-05 → 2026-05-07 *(window)* · Inventory, products, marketplaces

- **Phase 4.1 — Inventory module.** Hybrid perpetual model: real-time movements
  + periodic stocktaking sessions. `stocks`, `inventory_sessions`,
  `inventory_items`. *(migration 0011)*
- **Phase 5.1 — Products foundation.** `product_images` table; photos in R2
  (`das-erp-docs-dev`), metadata in D1. *(migration 0012)*
- Warehouse rename `wh_gzh_bw`/`GZH-BW` (Guangzhou Bonded) → `dgn`. *(migration 0013)*
- **Phase 6.0 — Marketplace stock snapshots** from Ozon and Wildberries;
  multipack convention encoded. *(migration 0014_marketplace_stocks)*
- **Bundling** added to `operations.operation_type` CHECK. *(migration 0015_bundling)*
- **END OF SESSION 2026-05-06 / 2026-05-07** recorded. *(reconstructed)* The
  static-export 404 problem for fresh detail routes is first flagged here and
  carried forward as the top backlog blocker.

---

## Phase 7 — 2026-05-08 → 2026-05-09 · Contracts registry, partner CRUD, clean-break partners

Two chats worked in parallel this stretch (one on contracts/UI, one on
invoicer/documents), coordinating via sha-checks and migration hand-offs.

- **Clean break — unified partners + prefix removal**, applied to prod
  **2026-05-08**. *(migration 0017)*
- Invoice-label internationalization. *(migration 0018)*
- `documents.pdf_converted_r2_url` — PDF versions via CloudConvert; `.docx`
  stays source of truth. *(migration 0016)*

**Phase 7.1 → 7.4 (EOS 2026-05-09 afternoon, 10 commits direct-to-main):**
- **7.1** — contract files in R2: `POST/GET/DELETE /api/contracts/:id/file`
  (multipart, 20 MB cap), R2 key `contracts/<company>/<ENTITY>-<ABBR>-<DATE>.pdf`.
  *(migration 0014_contract_file_key)*
- **7.1b** — abbreviation-aware filenames; upload refuses `422` if
  `partner.abbreviation` unset. *(migration 0015_partners_abbreviation)*
- **7.2 / 7.2b** — contract-file UI (drop-zone / view / replace / delete) +
  green PDF pill on partner-hub contracts table.
- **7.3 / 7.3b** — **Edit Partner** form (first generic CRUD edit screen);
  abbreviation length relaxed 4 → **2–6** to match the parallel chat's seed.
- **7.4** — cross-partner **/contracts registry** with 4 KPI cards, search,
  filters, clickable rows (first audit-friendly view of all 62 contracts).
- Documents-tab counter on operations made real (was hardcoded `(0)`).
- **Scar:** Aram flagged invoices as incorrect → deferred to the invoicer chat.
- **Lesson:** cross-chat schema coordination — `abbreviation` length picked as
  4 by one chat, 2–6 by the other; had to relax. *(source: EOS_2026-05-09_pm.md)*

---

## Phase 8 — 2026-05-09 · Real contracts, warehouse normalization, CRM legacy import

The evening session (9 commits, migrations 0019–0024) turned placeholders into
real records and fixed a marketplace-sync outage. *(source: docs/snapshots/2026-05-09-evening.md)*

- **Partner abbreviations — 70/70 unique seeded** (needed for contract
  numbering `DEE-{ABBR}-{YYYY}-{NNN}`); 3 collisions resolved; 3 unknown service
  providers researched. *(migration 0019)*
- **Warehouse `han` → `swh`** rename for id=lowercase(code) consistency;
  clarified `han` was Swift Hub, not Hanoi Bonded. *(migration 0020)*
- **Real manufacturer + intra-group contracts** seeded from the Drive Agreements
  folder (17 files walked, 9 new real records): DEE↔Honghui `080824`+A1,
  DEE↔Jinxia `MF01-DEA/YZ`, DEI↔DEE `06062022` chain (+DE-0125 +A1 +A2).
  *(migration 0021)*
- **F4 Lubertsy** real fulfillment contract №9 (2025-07-15) + addendum №1
  (2026-04-22) replacing the placeholder. *(migrations 0022, 0023)*
- **Currency fix** — manufacturer contracts corrected USD → **CNY** after the
  rule was clarified mid-session (DEE↔Chinese factory = CNY; any DEI chain = USD;
  Meizhiyuan = always USD). *(migration 0024)*
- **Unify agreements** into the contracts table. *(migration 0025)*
- **CRM legacy customers** — 912 rows imported from a Yandex KIT export (UI tab
  later removed, data kept for reference). *(migration 0026)*
- **Ozon Performance CPC sync RESTORED** end-to-end after Ozon's API contract
  change (CSV→JSON, `product_id`→`ozon_sku`): switched to `parseCpcJson`,
  2-step SKU map via `/v3/product/list` + `/v3/product/info/list`, admin trigger
  added. Verified 23/23 SKUs updated. *(snapshot 2026-05-09)*
- **Partners list/detail fix** — contract number now derived from the contracts
  table (earliest active main, `ROW_NUMBER()` + COALESCE fallback) instead of
  legacy partner columns. *(snapshot 2026-05-09)*
- **F4 Lubertsy = warehouse LBR** confirmed as one legal entity (ИП Швалев,
  INN 550412856773) in two views, verified against 34 Modulbank webhook rows.

**DB state at end of Day 8:** partners 70, warehouses 7, contracts 62 (20 real +
42 placeholder), operations 335, payments 358, products 57, stocks 52.

---

## Phase 9 — 2026-05-09 (evening, started) · Email-to-Operation / Invoice Inbox pipeline

- **Invoice Inbox foundation** — `invoice_inbox` table (18 cols, 4 indexes,
  3 FKs) + `payments.inbox_origin`. *(migration 0027)*, extended extraction
  fields *(migration 0028)*.
- **Decisions locked:** separate ops per line, no auto-create on unknown partner
  or uncertain classification, cron 03:00 МСК, `sale_payment` → `payment_pending`
  (amber dot). *(BACKLOG.md Phase 9.x)*
- **First invoice processed end-to-end:** Accuvat Tax Invoice 2026/00659 —
  found via emailer-bridge → Apps Script, PDF to R2, `pdftotext`, DeepSeek
  classified `service` @0.95, inserted as `needs_partner_link` (row
  `inv_44332bd44c2640b2`). The conservative-profile pipeline proven. *(BACKLOG.md)*

---

## Phase 3.x + schema hardening — 2026-05-10 → 2026-05-14 *(window)*

- `documents.document_number` implicit UNIQUE → **partial unique** (nulls/soft-
  deletes allowed). *(migration 0029)*
- **Language-model overhaul** — document language decided seller-side (issuer),
  not buyer-side. *(migration 0030)*
- **Delivery status** — third state dimension (physical fulfilment) on
  operations. *(migration 0031)*
- **RFQ** added to `documents.document_type` CHECK + rfq sequence. *(migration 0032_documents_rfq_type)*
- **OTW (on-the-way) virtual warehouse** + stock-state dimension. *(migration 0032_otw_and_stock_state)*
- `products.ctn_volume_m3` for logistics volume. *(migration 0033)*

---

## Service operations — 2026-05-14 *(window)* · Service partners & tracks

- **Service operations** foundation. *(migration 0034)* + service-partner
  follow-up backfill *(0035)*, operation-track backfill for service partners
  *(0036)*, partner subtype backfill from kind *(0037)*.
- `partners.acceptance_required` — flag to turn off the separate-acceptance
  requirement per partner. *(migration 0038)*

---

## Transfer batches & Telegram inbox — 2026-05-15 · "Aram law"

- **Transfer batches** — group F4→WH→R individual operations by (date,
  marketplace) under `OZN-/WB-YYMMDD` parents. *(migration 0039, Aram law 2026-05-15)*
- **Invoice Inbox — Telegram source** (`source_type` gmail|telegram); Telegram
  cron every 15 min; WATCHLIST senders bypass the classifier. *(migration 0040, Aram law 2026-05-15)*

---

## Finance depth — 2026-05-16 → 2026-05-31 *(window)*

- **Agent settlements** — triangle-settlement model. *(migration 0041)*
- **Money audit views** (`v_money`, per-table) — sanity-check layer that must be
  queried before quoting any sum. *(migration 0042)*
- `operation_type` CHECK widened to include **`service`, `tax`**;
  reclassification pass. *(migration 0043)*
- **Bank matching** matured to 3-state (Matched / Pending / Assign) with an
  invoice-number pre-classifier; Modulbank webhook + hourly cron; Yandex Pay
  finance flow → `DASR-YYYYMMDD`. *(source: _PROJECT.md current-state)*

---

## Planner, Auth, Self-healing — 2026-06-01 → 2026-06-10 *(window)*

- **Procurement Planner foundation** — lifecycle status, base_sku bundle
  linking, `planner_runs` history (one cycle = one manufacturer = one draft).
  *(migration 0044)*
- **Auth** — `users` + `sessions`, 3 users seeded, PINs hashed PBKDF2-SHA256
  (100k iters, per-user salt). *(migration 0045)* + per-user permissions JSON
  as the live source of truth *(migration 0046)*. Team: Meri (manager),
  Maria (support), Aram (admin); self-healing AuthGate.
- **Bank statement files** table recreated. *(migration 0047)*
- **Self-healing infrastructure** — `v_health`, watchdog cron (/10),
  auto-healer actions, Telegram escalation ≤ once / 3h. *(migration 0048)*
- **Attachment lock** — `operation_attachments.sent_at`; `409` on locked delete.
  *(migration 0049)*

---

## Phase 10 — 2026-06-11 · Loyalty Engine (RetailCRM replacement)

Registered as an EXTEND in the Vision-Coding registry on 2026-06-11.

- **Phase 10.0 — Loyalty Engine** «Клуб Экспертов» tiers (Свой 0₽/5% →
  Ценитель 10k/10% → Эксперт 25k/15% → Амбассадор 50k/20%): `loyalty_accounts`,
  `loyalty_transactions`, `loyalty_webhook_log`. Yandex KIT
  `ORDER_STATUS_CHANGED` → `/api/loyalty/webhook/kit`. *(migration 0050)*
- **Phase 10.1 — Loyalty redemptions** via personal KIT promo-codes
  (`DAS-XXXX-XX`, one-time, ≤50%-of-order rule, 48h TTL). *(migration 0051)*
- Frontend Pages project `das-bonus` → `bonus.dasexperten.ru`. *(vision-coding)*
- **RetailCRM exit** decided/executed — loyalty moved fully in-house.
  *(das-architektura/2026-06-12_kit-loyalty-engine-retailcrm-exit.md)*

---

## Activity, self-learning emailer — 2026-06-12 → 2026-06-20 *(window)*

- **User activity log** — append-only login/heartbeat/logout feeding the
  team-activity dashboard. *(migration 0052)*
- **Email Rules** (forward/delete). *(migration 0053)*
- **Email Tasks** — reframes Emailer from compose-&-send into a TASKS command
  center + learning loop. *(migration 0054)*
- **Email canon** — D1 hot cache of the distilled canon (source of truth stays
  R2 `email-canon/` + GitHub). *(migration 0055)*
- **Email Rules — two-layer (sender × type)**. *(migration 0056)*
- **Email classifications** — internal `email_type` tags (invisible to UI) for
  routing and two-layer rule writes. *(migration 0057)*

---

## Reviews & Marketplace feeds — 2026-06-21 → 2026-06-22

*(git history begins locally at 2026-06-21)*

- Reviews page built (iterated: inline-styles → GLM 5.2 → wired to real
  `/api/reviews/drafts`). *(git 414249b, 62f4e5c, f7705de)*
- **4-tab Reviews & Questions UI** (Ozon/WB reviews+questions), English. *(git e42e642, c4bb835)*
- **Marketplace feeds ingest** — Ozon reviews+questions & WB questions into D1
  (`/api/mp`); all 4 tabs wired to live D1 feeds; cron auto-refresh every 6h.
  *(git 96e27ea, 82749f3, 4be022d)*
- Ingest Ozon question **answers** (`/v1/question/answer/list`). *(git 220e26d)*
- Hide rating-only reviews (no text) on WB & Ozon; reviews visual polish. *(git 2dfeb05, 42faede, 3132712)*
- Mobile bottom-nav order set; das-kompanion chat panel responsive full-screen
  sheet <768px. *(git 0162556, c184d38)*

---

## Warehouses, bundling, operations lifecycle — 2026-06-23 → 2026-06-30

- Mobile: list tables render as stacked cards <768px; Pulse home personal
  greeting + marketplace-first order. *(git b4c9763, dd577ad)*
- **Stock Transfer between same-company warehouses** (modal). *(git d006e66, 257fe6d, 218840b)*
- **Bundling on Warehouses** + backdating; reference format `BD<WAREHOUSE>-NNN`
  per-warehouse counter; `ON CONFLICT (warehouse_id, product_id, stock_state)`
  fix. *(git 87e1226, f845ec2, 159f79e, 19fbbd1)*
- **Operation lifecycle as fixed-slot stage buttons** (SRV/DOC/PAY/SHP);
  `StatusStages` component; service stage signals exposed; tax = DOC/PAY only.
  *(git 010d2d2, c2eabc8, ee003ff, 45f8d49)*
- **inbox-reconcile** — nightly three-way deal builder (account/act/payment →
  one deal). *(git 3b5e727)*
- Shipped-transition fix (removed destructive phantom-clear); operations
  null-safe money formatter; one-click partner filter (reverted twice, then
  landed safely). *(git de5d040, e9de694, fd3b10c…a366e2d)*

---

## Reviews AI, prices resync, mobile audit, emailer perf — 2026-07-01 → 2026-07-02

- **Reviews reply generation** via GPT-5.5 (ChatGPT OAuth) primary → DeepSeek →
  Claude OAuth fallback chain; WB auto-reply throttled to 10/tick to fit cron
  wall-clock. *(git a6e0ecb, d7d5e3d, d467640, 093259e)*
- Marketplace **unfreeze feeds + watchdog coverage**. *(git 30fd3c7)*
- **Prices Resync** button — R2 pricelists → D1 `product_prices` (endpoint
  `admin-resync-prices.ts` + admin UI); price-type labels renamed
  (International / Russia Distr / Russia RSP / Purchasing / Dasex). *(git 12958e2, 1f6a0a7)*
- **Mobile full-page audit** — zero horizontal overflow, self-labelling cards,
  grid-blowout fixes, header/Pulse HUD fixes, wide tables scroll vs tall cards,
  across every screen. *(git fca099a … 9959ef5 … c906035, PRs #76–#79)*
- **Emailer perf** — small first page + KV-cache the inbox history. *(git 7f71aa9)*

---

## State at compile time (2026-07-03)

- **Live:** Worker `dasoperator-api.dasexperten.workers.dev`, Frontend
  `dasoperator.pages.dev`, D1 `das_erp_dev`.
- **Scale:** 60 migration files, 65 API route modules, 53 backend libs,
  41 UI pages, 30 components. Modules span Operations, Partners, Products,
  Contracts, Inventory/Warehouses, Documents/Invoicer, Marketplaces (Ozon/WB),
  Reviews, CRM, Loyalty, Finance/Banking (Modulbank), Inbox (Gmail/Telegram),
  Planner, Emailer, Auth, Self-healing, das-kompanion chat.
- **Open threads:** static-export 404 for fresh detail routes (long-standing),
  placeholder-contract normalization, VTB manual-CSV path, Wio Bank API
  (awaiting approval), Cloudflare Access SSO before wider rollout. See
  [`../BACKLOG.md`](../BACKLOG.md) for the live backlog.
