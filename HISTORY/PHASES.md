# Das Operator ERP — Phase Roadmap

The project advanced in numbered phases. This maps each phase to its status,
what delivered it, and which migrations/commits belong to it. Phase numbers come
from migration headers, the README status table, and session notes; work in the
git-history window (2026-06-21+) was largely shipped as feature commits rather
than numbered phases and is grouped at the end.

Legend: ✅ done · 🟢 live/iterating · ⏳ open/deferred

| Phase | Title | Status | Delivered by |
|---|---|---|---|
| 1.0 | Repository skeleton (api/web/db/docs) | ✅ | repo scaffold |
| 1.0a | Cloudflare Pages Static Export fix | ✅ | first deploy |
| 1.1 | D1 initial schema (16 tables) | ✅ | migration 0001, 0003 |
| 1.2 | Reference data seed | ✅ | migration 0002 |
| 2.0c | Invoicer foundation (schema + roles + routes) | ✅ | migrations 0007–0009 |
| 2.x | Operations reference · contracts · payments · VAT | ✅ | migrations 0004–0006, 0010 |
| 3.0 | UI shell (dashboards, forms) | 🟢 | web/ pages (41 pages) |
| 3.x | Documents hardening · delivery status · RFQ · OTW · language model | ✅ | migrations 0029–0032 |
| 4.1 | Inventory module schema | ✅ | migration 0011 |
| 4.5 | Inventory action forms (start/adjust/receipt/recount wizards) | ⏳ | routes exist; some forms placeholder (BACKLOG item I) |
| 5.1 | Products foundation (images) | ✅ | migration 0012 |
| 5.4 | Products edit + create | ⏳ | partial (BACKLOG item H) |
| 5.5 | Photo polish (crop, reorder, thumbnails) | ⏳ | BACKLOG item J |
| 6.0 | Marketplace stock snapshots (Ozon + WB) | ✅ | migration 0014_marketplace_stocks |
| 6.x | Marketplace feeds — reviews/questions ingest + CPC | 🟢 | migrations + git (2026-06) |
| 7.1 | Contract files in R2 | ✅ | migration 0014_contract_file_key |
| 7.1b | Abbreviation-aware filenames | ✅ | migration 0015_partners_abbreviation |
| 7.2 | Contract-file UI | ✅ | EOS 2026-05-09 pm |
| 7.3 | Edit Partner form (first generic CRUD) | ✅ | EOS 2026-05-09 pm |
| 7.4 | Cross-partner /contracts registry | ✅ | EOS 2026-05-09 pm |
| 7.x | Banking — Modulbank webhook, 3-state matching, agent settlements, money audit | 🟢 | migrations 0041–0042, 0047, 0049 |
| 8.x | Real contracts · warehouse normalization · CRM legacy · partner abbreviations | ✅ | migrations 0019–0026 |
| 9.x | Email-to-Operation / Invoice Inbox pipeline (Gmail + Telegram) | 🟢 | migrations 0027–0028, 0040 |
| 10.0 | Loyalty Engine «Клуб Экспертов» (RetailCRM replacement) | ✅ | migration 0050 |
| 10.1 | Loyalty redemptions (KIT promo-codes) | ✅ | migration 0051 |

## Sub-phases still open (from BACKLOG.md)

These are the named items carried across sessions without a final close:

- **A — Static Export 404 fix** *(blocker, open since 2026-05-07)* — fresh
  detail routes (new product/partner/operation) 404 until next deploy. Decision
  pending: drop `output: export` → SSR/Workers runtime · SPA-fallback · modal
  overlays. ~2–3 h.
- **C/D — Operation detail page + status update from UI** *(depends on A)*.
- **F — Documents tab UI on operation detail** *(depends on C)*.
- **H — Products edit + create** · **I — Inventory action forms** ·
  **J — Photo polish**.
- **K — VTB integration** — manual CSV import path (УНЭП can't run on Workers).
- **L — Wio Bank API** — awaiting bank approval (request sent 2026-05-08).
- **M — Cloudflare Access SSO** — before wider rollout.
- **N — CF Pages git-trigger reliability** — direct `wrangler pages deploy` is
  the reliable fallback.
- **O — cosmetic `_minor`/`Cents` variable rename** — values correct, names stale.

See [`../BACKLOG.md`](../BACKLOG.md) for the authoritative live backlog with
current priorities and estimates.

## The two-track parallelism

Through May 2026 two chats ran concurrently — one owning contracts/UI/partners,
the other owning `api/src/skills/invoicer/*`, `documents.ts`, and invoice
numbering. This is why numbers `0014`/`0015`/`0032` collided and why several
session notes carry a "PARALLEL CHAT TERRITORY — do not touch" section. Any new
work should keep the same discipline: pull latest `main`, sha-check before every
write, and never renumber an applied migration.
