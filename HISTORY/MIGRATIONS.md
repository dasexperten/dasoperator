# Das Operator ERP — Migration Ledger

Annotated index of all **60 D1 migration files** in [`../db/migrations/`](../db/migrations/).
One row each: what it changed and the phase/date it belongs to. This is the
authoritative "how the schema got here" record.

**Numbering note:** three numbers were used twice because two chats worked in
parallel and both grabbed the next free number before merging — `0014`, `0015`,
and `0032` each exist as two distinct files. They are *not* duplicates; each
made a different change. All are listed below.

**Prod-application note:** migrations were applied to prod (`das_erp_dev`)
directly via the Cloudflare D1 REST API during the session that authored them —
not through a single deploy step. Dates below are the authoring session; the ones
whose headers state an explicit apply date are marked **(prod: DATE)**.

| # | File | Phase | Change |
|---|---|---|---|
| 0001 | `0001_init.sql` | 1.1 | Initial schema — 16 tables (reference / operational / system layers) |
| 0002 | `0002_seed_reference.sql` | 1.2 | Reference data seed — companies, partners, products |
| 0003 | `0003_seed_phase11.sql` | 1.1 | Populate companies + sequences |
| 0004 | `0004_add_operations_reference.sql` | 2.x | Add `operations.reference` (`PARTNERABBR-YYMMDDXX`) |
| 0005 | `0005_contracts_and_payment.sql` | 2.x | Contracts table + payment-markdown enhancements |
| 0006 | `0006_payments_and_cleanup.sql` | 2.x | Payments table + drop legacy `paid` columns |
| 0007 | `0007_invoicer_foundation.sql` | 2.0c | Invoicer engine schema rewrite |
| 0008 | `0008_seed_invoicer_data.sql` | 2.0c | Seed invoicer data + product-id rename + test cleanup |
| 0009 | `0009_invoicer_roles_and_routes.sql` | 2.0c | Invoicer roles + manufacturer bank routes + `seq_is` |
| 0010 | `0010_add_vat_rate.sql` | 2.x | VAT rate on contracts and operations |
| 0011 | `0011_inventory.sql` | 4.1 | Inventory module — hybrid perpetual (movements + sessions) |
| 0012 | `0012_product_images.sql` | 5.1 | `product_images` (photos in R2, metadata in D1) |
| 0013 | `0013_rename_gzh_bw_to_dgn.sql` | 5.x | Rename warehouse `gzh_bw`/`GZH-BW` → `dgn` |
| 0014a | `0014_contract_file_key.sql` | 7.1 | `contracts.contract_file_key` (R2 object key) |
| 0014b | `0014_marketplace_stocks.sql` | 6.0 | Marketplace stock snapshots (Ozon + WB, multipack convention) |
| 0015a | `0015_bundling.sql` | 6.x | Add `bundling` to `operations.operation_type` CHECK |
| 0015b | `0015_partners_abbreviation.sql` | 7.1b | `partners.abbreviation` column (upload `422` if unset) |
| 0016 | `0016_documents_pdf_column.sql` | 7.x | `documents.pdf_converted_r2_url` (CloudConvert PDF; docx = source) |
| 0017 | `0017_clean_break_partners_unified.sql` | 7.x | Clean break — unified partners + prefix removal **(prod: 2026-05-08)** |
| 0018 | `0018_invoice_label_i18n.sql` | 7.x | Invoice-label internationalization |
| 0019 | `0019_partners_abbreviation_seed.sql` | 8.x | Seed all 70 partner abbreviations + unique index **(prod: 2026-05-09)** |
| 0020 | `0020_warehouse_han_to_swh.sql` | 8.x | Rename warehouse `han` → `swh` (id = lowercase(code)) **(prod: 2026-05-09)** |
| 0021 | `0021_seed_real_manufacturer_intragroup_contracts.sql` | 8.x | Real manufacturer + intra-group contracts from Drive Agreements **(prod: 2026-05-09)** |
| 0022 | `0022_seed_f4_lubertsy_real_contract.sql` | 8.x | F4 Lubertsy real contract №9 (2025-07-15) **(prod: 2026-05-09)** |
| 0023 | `0023_seed_f4_lubertsy_addendum_1.sql` | 8.x | F4 Lubertsy addendum №1 (2026-04-22) **(prod: 2026-05-09)** |
| 0024 | `0024_fix_manufacturer_contracts_currency.sql` | 8.x | Fix manufacturer contracts currency USD → CNY **(prod: 2026-05-09)** |
| 0025 | `0025_unify_agreements.sql` | 8.x | Unify agreements into contracts table **(prod: 2026-05-09)** |
| 0026 | `0026_crm_legacy_customers.sql` | 8.x | CRM legacy customers — 912 rows from Yandex KIT export **(prod: 2026-05-09)** |
| 0027 | `0027_invoice_inbox.sql` | 9.x | Invoice Inbox foundation — `invoice_inbox` + `payments.inbox_origin` **(prod: 2026-05-09)** |
| 0028 | `0028_invoice_inbox_extended_fields.sql` | 9.x | Extended extraction fields for `invoice_inbox` **(prod: 2026-05-09)** |
| 0029 | `0029_documents_partial_unique.sql` | 3.x | `documents.document_number` → partial unique index |
| 0030 | `0030_language_model_overhaul.sql` | 3.x | Document language decided seller-side (issuer), not buyer-side |
| 0031 | `0031_operations_delivery_status.sql` | 3.x | Delivery/fulfilment status — third operation-state dimension |
| 0032a | `0032_documents_rfq_type.sql` | 3.x | Add `RFQ` to `documents.document_type` CHECK + rfq sequence |
| 0032b | `0032_otw_and_stock_state.sql` | 3.x | OTW (on-the-way) virtual warehouse + stock-state dimension |
| 0033 | `0033_products_ctn_volume_m3.sql` | 5.x | `products.ctn_volume_m3` (logistics volume) |
| 0034 | `0034_service_operations.sql` | — | Service operations foundation |
| 0035 | `0035_service_partners_followup_backfill.sql` | — | Service-partners follow-up backfill |
| 0036 | `0036_backfill_operation_track_for_service_partners.sql` | — | Backfill `operation_track` for service partners |
| 0037 | `0037_backfill_partner_subtype_from_kind.sql` | — | Backfill partner subtype from kind |
| 0038 | `0038_partner_acceptance_required.sql` | — | `partners.acceptance_required` flag |
| 0039 | `0039_transfer_batches.sql` | — | Transfer batches — group F4-WH-R ops by (date, marketplace) **(Aram law 2026-05-15)** |
| 0040 | `0040_invoice_inbox_telegram.sql` | 9.x | `invoice_inbox` telegram source + 15-min cron + WATCHLIST bypass **(Aram law 2026-05-15)** |
| 0041 | `0041_agent_settlements.sql` | 7.x | Agent settlements — triangle-settlement model |
| 0042 | `0042_money_audit_view.sql` | 7.x | Money audit views (`v_money`, per-table) |
| 0043 | `0043_operation_type_service_tax.sql` | — | Widen `operation_type` CHECK to add `service`, `tax` |
| 0044 | `0044_planner_foundation.sql` | — | Procurement Planner foundation + `planner_runs` history |
| 0045 | `0045_auth_users_and_sessions.sql` | — | Auth: `users` + `sessions`; 3 users; PINs PBKDF2-SHA256 (100k) |
| 0046 | `0046_user_permissions.sql` | — | Per-user permissions JSON (live source of truth over role) |
| 0047 | `0047_create_bank_statement_files.sql` | 7.x | Recreate `bank_statement_files` |
| 0048 | `0048_self_healing_foundation.sql` | — | Self-healing infra — `v_health`, watchdog, healer actions |
| 0049 | `0049_attachment_sent_at.sql` | 7.x | Attachment lock — `operation_attachments.sent_at` (409 on locked delete) |
| 0050 | `0050_loyalty_engine.sql` | 10.0 | Loyalty Engine «Клуб Экспертов» tiers + KIT webhook **(2026-06-11)** |
| 0051 | `0051_loyalty_redemptions.sql` | 10.1 | Loyalty redemptions — personal KIT promo-codes (48h TTL) **(2026-06-11)** |
| 0052 | `0052_user_activity.sql` | — | `user_activity` append-only log (team dashboard) |
| 0053 | `0053_email_rules.sql` | — | `email_rules` (forward/delete) |
| 0054 | `0054_email_tasks.sql` | — | `email_tasks` — Emailer reframed as TASKS command center + learning loop |
| 0055 | `0055_email_canon_cache.sql` | — | `email_canon` D1 hot cache (source of truth: R2 + GitHub) |
| 0056 | `0056_email_rules_two_layer.sql` | — | Email rules two-layer (sender × type) |
| 0057 | `0057_email_classifications.sql` | — | `email_classifications` internal `email_type` tags (UI-invisible) |

## Migration conventions (from ADR 002)

- Migrations are **append-only** — never edit one already applied to prod.
- D1/SQLite has **no `ALTER COLUMN`** — constraint changes require full table
  recreation, copying CHECK/FK/index definitions 1-for-1.
- `schema.ts` (Drizzle) is kept in sync **by hand**; it currently defines 19
  tables and lags the live D1, which also carries tables created directly by
  later migrations (`invoice_inbox`, `loyalty_*`, `email_*`, `planner_runs`,
  `agent_settlements`, `bank_statement_files`, `user_activity`, sessions, etc.).
  Treat the migrations as the true schema record.
