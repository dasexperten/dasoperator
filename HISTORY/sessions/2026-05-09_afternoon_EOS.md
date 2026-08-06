DAS OPERATOR ERP — END OF SESSION 2026-05-09 (afternoon, this chat)
═══════════════════════════════════════════════════════════════

LIVE PRODUCTION

  Worker:    dasoperator-api.dasexperten.workers.dev
             v1.8+ / phase 7.4-contracts-registry
             (parallel chat may bump version after invoicer rework)
  Frontend:  dasoperator.pages.dev  (CF Pages git-trigger working)

═══════════════════════════════════════════════════════════════

DELIVERED THIS CHAT (10 commits, direct-to-main)

  Phase 7.1   — contracts: R2 file upload/download/delete
                · migration 0014: contracts.contract_file_key TEXT
                · POST   /api/contracts/:id/file (multipart, 20MB cap)
                · GET    /api/contracts/:id/file (PDF stream)
                · DELETE /api/contracts/:id/file (R2 + DB cleanup)
                · R2 key: contracts/<our_company_id>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf
                · Bucket: das-erp-docs-dev (existing DOCS binding)

  Phase 7.1b  — abbreviation-aware filename
                · migration 0015: partners.abbreviation TEXT
                · Upload refuses 422 if partner.abbreviation unset
                · slugify() helper removed

  Phase 7.2   — contract file UI (/partners/[slug]/contracts/[id])
                · Drop-zone when no file (PDF, max 20MB)
                · View / Replace / Delete when file present
                · Confirms before delete
                · Filename hint shows ENTITY-ABBR-DATE pattern

  Phase 7.2b  — File column on partner-hub Contracts table
                · Green PDF pill (clickable) when file exists
                · Em-dash with FileX icon when missing
                · Backend GET /api/partners/:slug/contracts now
                  returns contract_file_key

  Phase 7.3   — Edit Partner form (/partners/[slug]/edit)
                · Full form: Identity / Banking / Tax / Commercial / Notes
                · Trade name read-only (slug invariant)
                · Abbreviation field with auto-uppercase + validation
                · Edit Partner button on partner hub hero (top-right)
                · Code badge on hero when abbreviation is set
                · Diff-based PATCH (only changed fields)
                · Server-side zod errors per field

  Phase 7.3b  — abbreviation length 2-6 (parallel chat compat)
                · Was 4, now 2-6 to match migration 0019 seed
                  (parallel chat seeded all 70 partners, ranging
                  from 2 to 4 letters: e.g. RP=2, AKV=3, LETU=4)
                · Backend zod regex updated
                · Frontend input maxLength + label updated

  Phase 7.4   — cross-partner Contracts registry (/contracts)
                · 4 KPI cards: Total / Real / Placeholder / With PDF
                · Search: contract_no / partner / abbr / notes
                · Filters: Entity / Status / File / Type
                · Table columns: Contract No / Entity / Partner /
                  Code / Currency / Signed / File / Status
                · Both contract_no and partner clickable
                · Sidebar entry between Operations and Products
                · Backend GET /api/contracts now returns
                  partner_abbreviation

  Phase 7.x   — Documents tab counter fix
                · Was: hardcoded 'Documents (0)' regardless of count
                · Now: parent fetches docs alongside line_items /
                  payments / stock_movements in same Promise.all
                · DocumentsTab accepts initialDocs (skip refetch)
                  and onChange (so issuing updates parent counter)

  Cleanup pass (A1-A4)
                · Latent issue 1 (orphan line_items prd_de101) —
                  already fixed by parallel chat
                · Latent issue 2 (DEE-007 negative stocks) —
                  already fixed; stocks now actively used (52 rows)
                · marketplace_ozon_sku_map deprecation note in
                  docs/notes/marketplace_ozon_sku_map_deprecated.md
                · R2 audit: 28 files, no orphan refs, no test files
                · Ozon /v3 cron tick #11 at 12:05 UTC: ✅ ok,
                  23 SKUs updated — full restore confirmed

═══════════════════════════════════════════════════════════════

DECISIONS LOCKED THIS SESSION

  Contract numbering:
    · Numbers stay free-text from the actual paper (no synthetic).
    · Old contracts in odd formats (01112023, Bl-A 1301, DEI2601,
      etc.) are kept as historical legacy — never renumbered.
    · New contracts: format DEE-LETU-<paper-no>, where
      DEE = our entity, LETU = partner.abbreviation, paper-no =
      free-text from the document.

  Partner abbreviations:
    · 4-letter idea relaxed to 2-6 letters (parallel chat seeded
      with this range). All 70 partners have a code now.
    · Used in contract filenames in R2.

  Contract files:
    · Stored in R2 as contracts/<our_company_id>/<ENTITY>-<ABBR>-<YYYY-MM-DD>.pdf
    · contracts.contract_file_key holds the R2 object key.
    · No auth on file fetch — same as invoices today.

  Placeholder contracts:
    · Stay as NO-CONTRACT-* until real paper is signed.
    · Visual cues already enforced everywhere (dashed pill).
    · 42 still open at session end (was 42 in morning snapshot —
      parallel chat replaced 1 from F4 Lubertsy via 0022/0023, but
      added more elsewhere).

═══════════════════════════════════════════════════════════════

DB STATE AT SESSION END

  partners:        70  (all have abbreviation)
  contracts:       62  (20 real + 42 placeholder)
  contracts_with_pdf: 0  (UI ready, awaiting first paper upload)
  operations:     335
  payments:       358
  documents:        3  (parallel chat actively rebuilding invoicer)
  stocks:          52  (live data, no negatives)
  stock_movements: 54
  products:        57

  Last perf_reports: ok / 23 / 23 (full Ozon CPC sync working)

═══════════════════════════════════════════════════════════════

OPEN BACKLOG (priority order)

  HIGHEST — needs Aram's hands

  1. Upload signed contract PDFs through UI
     · /partners/[slug]/contracts/[id] → drag PDF to drop-zone
     · Filename auto-formed as ENTITY-ABBR-DATE.pdf
     · Once uploaded, contract counts as "real" even if
       contract_no is still placeholder. Edit contract_no later
       when document detail PATCH is added (see open code below).

  2. Replace placeholder contract numbers as paper appears
     · Currently 42 placeholders. As real contracts come in,
       partner clicks contract on hub, types real number,
       saves. Today this requires creating new contract +
       moving operations — one task at a time.

  PARALLEL CHAT TERRITORY (do not touch)

  3. Invoicer rework
     · Aram flagged invoices as "incorrect" this session.
     · Parallel chat owns api/src/skills/invoicer/* and is
       actively iterating (multiple commits today: pickLineLabel,
       CI bank fall-back, sequence id strip, manufacturer routes).
     · Specs: docs/specs/upd-tn-reference/SPEC.md +
       example-upd-95.pdf reference.

  4. Real manufacturer/intra-group contracts seed
     · Parallel chat already added 0021 (manufacturer contracts:
       DEE↔Honghui, DEE↔Jinxia, DEI↔DEE), 0022 (F4 Lubertsy),
       0023 (F4 Lubertsy addendum) during this session.
     · More expected.

  CODE HOLES NOT YET FILLED

  5. PATCH /api/contracts/:id endpoint
     · Currently no way to edit contract_no, signed_date, status,
       notes through API. Only POST (create) + DELETE (file) +
       PUT (file). Needed when Aram replaces a placeholder
       contract_no with a real number.
     · If/when added, also expose Edit button on contract detail
       page like Edit Partner exists on partner hub.

  6. Cross-partner /agreements registry?
     · /contracts is for distribution/supply contracts. NDAs and
       MOUs live in partner_agreements (separate table). Currently
       only visible per-partner. A cross-partner registry could
       help Aram audit signed NDAs.

  LOWER PRIORITY

  7. Phase 5.5 cosmetic refactor — remaining _minor variable
     names, font 12px usages on contract detail page (small,
     benign cleanup)

  8. Cloudflare Access auth — public UI/API → SSO-protected
     before sharing wider.

  9. VTB integration — manual CSV import path is the answer
     (УНЭП cert can't run on Workers). When Aram is ready.

  10. Wio Bank API — awaiting bank approval (request sent
      2026-05-08).

═══════════════════════════════════════════════════════════════

PARALLEL CHAT MIGRATIONS LANDED THIS DAY

  0019 — partners.abbreviation seed (all 70 partners coded)
  0020 — warehouse han → swh rename for ID consistency
  0021 — real manufacturer/intra-group contracts (Honghui, Jinxia, DEI↔DEE)
  0022 — F4 Lubertsy real contract
  0023 — F4 Lubertsy addendum 1

  Plus this chat:
  0014 — contracts.contract_file_key
  0015 — partners.abbreviation (column structure; 0019 was seed)

═══════════════════════════════════════════════════════════════

KNOWN LATENT (no action this session, snapshot for context)

  - marketplace_ozon_sku_map: empty, unused. Documented as
    deprecated in docs/notes/. Drop or repurpose later.
  - 78 outgoing bank_transactions deliberately unmatched (internal
    DEE↔DEE transfers, Modulbank fees, owner withdrawal).
  - 194 incoming bank_transactions deliberately unmatched (all
    marketplace payouts, by Q1=A 2026-05-08 policy).
  - Some legacy variable names with _minor suffix in net-balance
    code (cosmetic only).

═══════════════════════════════════════════════════════════════

DEPLOYMENT (still works as documented)

  api/**: GitHub Actions auto-deploys Worker on push to main.
          Token in workflow: CF Cloud Master (cfut_yk9D...).

  web/**: CF Pages git-trigger on push to main. Worked reliably
          this session (3+ deploys in a row, all green).
          Fallback: cd web && npx wrangler pages deploy
          .vercel/output/static --project-name=dasoperator
          --branch=main --commit-dirty=true with CF Cloud Master.

═══════════════════════════════════════════════════════════════

UI / FONT RULES (still enforced)

  - No font sizes below 14px (one 12px holdout on contract detail
    placeholder pill, low priority cleanup)
  - Letter-spacing never exceeds 0
  - Operations table bold: Reference, Partner name, Total
  - Products table bold: SKU, Product name
  - Partners table bold: Country, Net Debt
  - All form input values bold (font-weight 700)
  - All numerics bold globally
  - No quotation marks in prose
  - NEW: Placeholder contracts as dashed pills, Code field as
    bold 2-6 letter pill on partner hub

═══════════════════════════════════════════════════════════════

TOKENS (still live, no rotation needed)

  All tokens are documented in das-secrets-masterfile.md (project-level).
  Names for quick reference:

  GitHub PAT
  CF Workers Edit
  CF Full Infra
  CF D1 Admin
  CF Pages Master / Cloud Master  ← USE THIS FOR ALL DEPLOYS
  DeepSeek (Worker secret DEEPSEEK_API_KEY)
  WB API JWT
  Ozon Client-Id / Api-Key
  Resend (rumailer-bridge — RESEND_API_KEY Worker secret)
  Modulbank DEE (Worker secret MODULBANK_TOKEN_DEE)

═══════════════════════════════════════════════════════════════

NEW CHAT START

  Paste this snapshot first message.
  Recommended opening lines:

  "продолжаем Das Operator ERP — после загрузки реальных контрактов
   как PDF, завести PATCH /api/contracts/:id чтобы редактировать
   contract_no через UI"

  Or:

  "продолжаем Das Operator ERP — мониторинг что параллельный чат
   доделал с invoicer"

  Or anything else from the OPEN BACKLOG section above.

═══════════════════════════════════════════════════════════════

DAY 7 PM SCORECARD (2026-05-09 afternoon)

  Commits merged:    10 direct-to-main
  Lines of code:     ~900 frontend + ~120 backend + ~310 docs
  Migrations applied: 2 (0014 contract_file_key, 0015 partners.abbreviation)
                     Plus parallel chat: 0019, 0020, 0021, 0022, 0023
  Major win:         Contract files are now uploadable through UI
                     end-to-end (drop PDF, see in R2, see green pill
                     on partner hub, see in /contracts registry)
  Major win:         Cross-partner /contracts registry — first time
                     audit-friendly view of all 62 contracts at once
  Major win:         Edit Partner form — first generic CRUD edit
                     screen in the system
  Major win:         Documents tab counter on operations now real
  Major non-win:     Aram says invoices are incorrect; deferred to
                     parallel chat per their territory
  Lessons:           1) Always re-check parallel chat migrations
                        before assuming snapshot is current
                     2) Schema choices like partner.abbreviation
                        length need cross-chat coordination —
                        I picked 4, parallel chat picked 2-6, had
                        to relax mine to match.

═══════════════════════════════════════════════════════════════
