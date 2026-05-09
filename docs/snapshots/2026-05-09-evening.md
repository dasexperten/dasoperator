# DAS OPERATOR ERP — END OF SESSION 2026-05-09 (evening)

Session focus: Ozon Performance API CPC sync, partner abbreviations,
real contract seeding from Drive Agreements folder, warehouse ID
normalization, partners list contract field fix.

═══════════════════════════════════════════════════════════════

## LIVE PRODUCTION

  Worker:    dasoperator-api.dasexperten.workers.dev
  Frontend:  dasoperator.pages.dev
  D1:        das_erp_dev (id 0653d156-5069-4c46-a496-fad982d0d1df)
  Migrations applied: 0001 → 0024

═══════════════════════════════════════════════════════════════

## DELIVERED THIS SESSION (commits today)

  9ffe892  Phase 8.x — partners list/detail: derive contract_no from contracts
  aa472ac  Phase 8.x — fix manufacturer contract currency USD→CNY
  bae9c93  Phase 8.x — F4 Lubertsy addendum №1 (new pricing blocks)
  37b7156  Phase 8.x — seed F4 Lubertsy real contract №9 from 2025-07-15
  f9345b7  Phase 8.x — seed real manufacturer + intra-group contracts from Drive
  ab403c4  Phase 8.x — rename warehouse han→swh for ID/code consistency
  0303d36  0019: seed partner abbreviations + unique index
  4cf3c3e  Ozon Performance ETL — admin manual trigger endpoint
  ae32063  Ozon Performance — JSON parser + 2-step SKU map (offer_id↔ozon_sku)

  Migrations 0019 → 0024 written to docs/snapshots/db/migrations/.

═══════════════════════════════════════════════════════════════

## KEY OUTCOMES

### 1. Ozon Performance CPC sync — RESTORED end-to-end

  Problem: Cron `5 */6 * * *` failing for weeks with `product/list HTTP 404`
  after Ozon's API contract change (CSV → JSON, product_id → ozon_sku).

  Fix:
    - Switched parseCpcCsv → parseCpcJson (JSON response handling)
    - Replaced 1-step refreshOzonSkuMap with 2-step:
        Step 1: GET /v3/product/list → {product_id, offer_id}
        Step 2: POST /v3/product/info/list → {product_id, sku} (Ozon SKU)
        Map: ozon_sku → offer_id (via product_id pivot)
    - Added admin trigger /admin/run-perf-create with bearer auth

  Verified: report 331b89ca-...-592efa553e7e — skus_updated 23/23
  in 53 seconds. Top spender DE119AA at 12,891.56 ₽ CPC.

### 2. Partner abbreviations — 70/70 unique seeded

  Required for contract numbering format DEE-{ABBR}-{YYYY}-{NNN}.
  Filled all 70 partners via interactive widget, resolved 3 collisions
  (INF1/INF2, PRIZ/TSKN, OZON/OZCR), researched 3 unfamiliar service
  providers (market_bridge=Ozon's MARKETPLACE LLC, moduldev=Modulkassa,
  retail_driver=RetailCRM).

  Field: partners.abbreviation TEXT (UNIQUE INDEX).
  Migration: 0019_partners_abbreviation_seed.sql (70 UPDATE statements).
  Coordinated with parallel chat which had created the column independently.

### 3. Real contracts seeded from Drive Agreements folder

  Walked all 17 files in https://drive.google.com/drive/folders/1izCzMpgaRU2BcQLqnbj7aIOZ_FeVRY_b
  Created 9 new real contract records (12 → 21 → 20 after corrections):

    DEE ↔ Honghui     080824 (2024-04-09) main + 080824/A1 addendum
    DEE ↔ Jinxia      MF01-DEA/YZ (2025-01-01) main
    DEI ↔ DEE         06062022 (2022-06-06, originally DEMEA) restored from soft-delete
                      + DE-0125 trilateral assignment (2025-12-28)
                      + 06062022/A1 (2026-01-15, extension to 2028-12-31)
                      + 06062022/A2 (2026-04-09, third-party payments)
    DEE ↔ F4 Lubertsy №9 (2025-07-15) fulfillment + 9/A1 addendum (2026-04-22)

  Final state: 20 real contracts + 42 placeholder = 62 total.

### 4. Currency rule for manufacturer contracts locked

  Memory-encoded rule:
    DEE ↔ Chinese factory (direct)        = CNY (VTB Shanghai yuan)
    DEI ↔ anything                        = USD (international)
    Any chain via DEI as intermediary     = USD
    Meizhiyuan ↔ anyone                   = USD (its export setup)

  Initial seed in migration 0021 had USD by mistake — corrected in 0024
  after re-reading file02 (Honghui RUS, 5,000,000 CNY total) and file14
  (Jinxia ENG Article 3.1 stated CNY).

### 5. Warehouse han → swh rename for ID/code consistency

  Inconsistency: warehouse had id='han' but code='SWH' (mismatch).
  Other 8 warehouses follow id=lowercase(code). Brought to single rule.
  No application code referenced 'han' (only one row in warehouse_companies
  for DASEAN role, repointed to swh).

  Note: 'han' name was Swift Hub (not Hanoi Bonded as in 0002 seed).
  Live DB amended; 0002 seed remains historical reference.

### 6. F4 Lubertsy = warehouse LBR clarified

  Confirmed: partner f4_lubertsy and warehouse LBR are the same legal
  entity (ИП Швалев Андрей Сергеевич, INN 550412856773, ОГРНИП
  322440000006410). Two perspectives on one object — operational
  (warehouse) vs legal/financial (partner for payments).

  Identity verified via 34 Modulbank webhook bank_transactions all
  showing same INN. Real fulfillment contract found and uploaded.

### 7. Partners list/detail endpoint fix

  Bug: GET /api/partners returned p.contract_no/p.contract_date from
  legacy partner columns, missing all 9 newly-seeded contracts. Result:
  Partners page showed "—" instead of contract №9 for F4 Lubertsy and
  others.

  Fix: LEFT JOIN with subquery picking earliest active main contract per
  partner (ROW_NUMBER() partition), COALESCE fallback to legacy columns.
  Effect: Partners page now displays real contract numbers from contracts
  table for all 21 real-contract partners.

═══════════════════════════════════════════════════════════════

## INFRASTRUCTURE STATE

  D1 das_erp_dev:
    partners:    70  (all with abbreviation, all with kind set)
    warehouses:  7   (active; jeb + yer soft-deleted by parallel chat)
    contracts:   62  (20 real + 42 placeholder)
    operations:  335
    payments:    358 (incl. 34 Modulbank-matched to F4 Lubertsy)
    Migrations:  0001 → 0024

  Real contracts (20):
    11 buyer/internal:
      torwey 14-01/092022, alfa_klass 15-02/2022 + Add.01,
      ratiya_ip 021123, dasex_group 01112023 + DEI2602,
      das_beste_product 261223, biznes_alyans 081124,
      ozon МП ИР-34138/22, bright_ideas Bl-A 1301,
      tori_georgia DEI2601
    2 manufacturer (CNY):
      honghui 080824 + 080824/A1
    1 manufacturer (CNY):
      jinxia MF01-DEA/YZ
    4 intra-group (USD):
      dei↔dee 06062022 + DE-0125 + 06062022/A1 + 06062022/A2
    2 fulfillment (RUB):
      f4_lubertsy 9 + 9/A1

  R2:    das-erp-docs-dev (active)
  KV:    das-counters / das-fx / das-cache (live)
  Cron:  0 12 * * * UTC daily FX refresh
         5 */6 * * * UTC Ozon Performance CPC sync (now working)

═══════════════════════════════════════════════════════════════

## ARCHITECTURAL DECISIONS LOCKED THIS SESSION

  Warehouse ID rule: id = lowercase(code) for all warehouses, no
                     prefixes (han→swh, applied 2026-05-09).

  Partner.abbreviation rule: 2-6 chars, UNIQUE, used in contract
                             numbering format DEE-{ABBR}-{YYYY}-{NNN}.

  Currency rule: CNY only for direct DEE↔Chinese-factory contracts;
                 anything via DEI = USD; Meizhiyuan = always USD.

  Contract integrity rule: never fabricate contract numbers; placeholder
                           NO-CONTRACT-{partner_id} stays until real
                           document found.

  Partners list field semantics: contract_no/contract_date on partners
                                 endpoint now derived from contracts
                                 table (earliest active main), with
                                 COALESCE fallback to legacy columns.

  F4 Lubertsy ↔ warehouse LBR: documented as one entity in two views
                               (partners.notes + this snapshot).

═══════════════════════════════════════════════════════════════

## OPEN BACKLOG

  HIGH-VALUE (continues from prior sessions):

  1. Normalize 41 placeholder contract IDs (~30 min)
     Current: placeholder_{partner}_rub
     Target:  Either delete (no real contract evidence) or rename to
              dee_{partner}_NOC pattern. Apply same flow used for
              f4_lubertsy: temp rename contract_no → clone → repoint →
              delete old.

  2. Static Export 404 fix (still open from 2026-05-07, ~2-3 hours)
     Operation/Partner/Product detail URLs not in build-time list still
     return 404 for fresh entities. Architecture decision pending:
     A) Drop output:export, switch to SSR/Workers runtime
     B) SPA-fallback for unknown detail routes
     C) Modal overlays instead of detail routes

  3. Operation detail page (~1 hour, depends on #2)
     /partners/[slug]/operations/[id] still doesn't exist as a real page.

  4. Operation status update from UI (~30 min, depends on #3)
     Buttons "Mark as issued/shipped/delivered" → PATCH /api/operations/:id/status

  MEDIUM-VALUE:

  5. Phase 5.4 step 5 — Products edit + create (~2-3 hours)
  6. Phase 4.5 — Inventory action forms (~2-3 hours)
  7. Phase 5.5 — Photo polish (~1-2 hours)
  8. Phase 3.0e — Documents tab UI on operation card (~1 hour)

  LOWER-PRIORITY:

  9. UPD/TN renderer upgrade (parallel chat territory)
  10. Phase 7.x VTB integration (manual CSV import path)
  11. Wio Bank API access (awaiting bank approval)
  12. Cloudflare Access SSO before broader rollout
  13. Drop legacy manufacturers table after parallel chat migrates
  14. partner_language fully replaces preferred_invoice_language
  15. Investigate CF Pages git-trigger flakiness
  16. Possible DEI↔Meizhiyuan / DEI↔Honghui / DEI↔Jinxia placeholder
      contracts when first ops appear (USD currency rule)

═══════════════════════════════════════════════════════════════

## PARALLEL CHAT TERRITORY (do not touch)

  api/src/skills/invoicer/*
  api/src/routes/documents.ts (POST /issue + GET /:id/download)
  warehouse_companies / warehouse_manufacturers junction tables
  operations.status CHECK constraint
  product_skill SKU master at /mnt/skills/user/product-skill/
  Migration 0029 (newer than this session) — merge if conflict
  invoice numbering format change (commit 6bb2269 introduced
  deterministic {TYPE}-{ISSUER}-{YY}{NNNN} format)

═══════════════════════════════════════════════════════════════

## KNOWN LATENT ISSUES (not blockers)

  - 41 placeholder contracts still have id pattern placeholder_{x}_rub
    (cosmetic; works fine functionally)
  - 2 warehouses soft-deleted by parallel chat: jeb, yer (intentional)
  - Some legacy variable names with _minor suffix in code (cosmetic)
  - 3 old line_items rows from PR-C2 smoke test reference non-existent
    prd_de101 (hidden, not breaking)
  - /api/products/lookup endpoint searches column 'sku' that doesn't
    exist (parallel chat owns this)
  - DEE-007 stocks.on_hand = -240 (negative) from earlier transition test

═══════════════════════════════════════════════════════════════

## TOKENS (live, values stored in das-secrets-masterfile.md, not here)

  GitHub PAT
  CF Workers Edit
  CF Full Infra
  CF D1 Admin
  CF Pages Master
  DeepSeek API key (Worker secret DEEPSEEK_API_KEY)
  Ozon Seller Client-Id + Api-Key
  Ozon Performance Client-Id + Client-Secret
  Admin secret bearer for /admin/* endpoints

═══════════════════════════════════════════════════════════════

## NEW CHAT START

  Paste this snapshot first message.
  Recommended opening line:

  "продолжаем Das Operator ERP — нормализация placeholder ID"

  Or skip to high-value architecture work:

  "продолжаем Das Operator ERP — Static Export 404 fix"

═══════════════════════════════════════════════════════════════

## DAY 8 SCORECARD (2026-05-09)

  Commits merged:    9 to main (direct push, no PRs)
  Migrations:        6 (0019, 0020, 0021, 0022, 0023, 0024)
  Lines of code:     ~600 (Worker route logic + SQL)
  Major wins:
    • Ozon CPC sync restored end-to-end after Ozon API contract change
    • 70 partner abbreviations seeded with uniqueness guard
    • 9 real contracts moved from PDFs to D1 contracts table
    • Partners page now shows real contract numbers (was a regression
      since contracts table introduction)
  Major scar:
    • Initially seeded manufacturer contracts in USD when they're CNY —
      caught only after rule clarified mid-session
    • Soft-deleted main contract 06062022 found by accident; restored

═══════════════════════════════════════════════════════════════
