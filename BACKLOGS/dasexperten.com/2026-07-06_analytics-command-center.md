# 2026-07-06 — Analytics Command Center

> Session: rebuild of the standard Wix + Shopify analytics dashboard set inside
> **dasoperator `/analytics`** for dasexperten.com, fed by own sources, refreshed nightly.
> Wix/Shopify used as functional spec only (their public dashboard catalogs) — no accounts connected.
> Executed from the WEB-ANALYTICS-COMMAND-CENTER brief (SECRETS convention — credentials never in git).

## Result

Both PRs merged to `dasexperten/dasoperator` main by owner, live in production same day:

- **PR #96** — Web Analytics Command Center (phases 0/1/3/4)
- **PR #98** — design-discipline follow-up (interaction tiers)

All five tabs live at `dasoperator.pages.dev/analytics` with real data. D1 archive tables
created in prod; first nightly cron run 2026-07-07 02:30 UTC.

## What changed (by phase)

### Phase 0 — Design system pilot
- `web/design-system/` = working copy of the Das Experten handoff bundle
  (colors_and_type.css, assets, ui_kits, preview, README, SKILL). Distributor ui_kit =
  dashboard styling reference. `/analytics` is the pilot of the new system; old
  `dasoperator/Design/` stays valid for the rest of the ERP.
- `web/styles/das-design-tokens.css`: added the mandatory interaction-state tokens
  (`--dx-focus-ring`, `--dx-hover-lift`, `--dx-hover-lift-dark`, `--dx-tap-target-min`,
  `--dx-transition-fast`) + global `:focus-visible` ring + reduced-motion rule.
- Known issue honored: `fonts/Eras-Bold_Regular.ttf` corrupted → display falls back to
  Archivo Black per the bundle's own note.

### Phase 1 — Parity spec
- `docs/analytics-parity.md`: Shopify catalog S1–S17 + Wix catalog W1–W17, each metric
  mapped to GA4 / Clarity / Metrika / Direct / Ads / D1 orders — or explicitly **CUT**
  (cohorts, abandoned-cart records, realtime, forms, reports duplicated elsewhere in ERP).
  NONE rows are never faked in UI. Blend rule documented: three trackers see three
  volumes (geo + consent + sampling) — every tab labels its source, no silent blending.

### Phase 3 — Ingestion layer (api/, Worker `dasoperator-api`)
- `lib/ga4.ts` + `routes/ga4.ts`: GA4 Data API v1beta via service-account JWT
  (RS256 signed with WebCrypto, PKCS8 import), access token KV-cached 55 min.
  Endpoints `/api/ga4/overview | channels | pages | funnel`, all
  `{window_days, totals, rows, synced_at}`, KV-cached 1h. Funnel = page_view →
  view_item → add_to_cart → begin_checkout → purchase.
- `lib/clarity.ts` + `routes/clarity.ts`: `/api/clarity/behavior`, normalizes all metric
  blocks (Traffic, EngagementTime, ScrollDepth, dead/rage/quickback/excessive-scroll/
  script-error/error-click signals, PopularPages/ReferrerUrl/Device/Country/OS/Browser).
  **Quota discipline (10 calls/project/day hard limit): nightly cron makes EXACTLY one
  call and pre-warms the same 24h KV key the endpoint serves** — dashboard browsing never
  burns quota. No historical backfill exists — D1 accumulation IS the archive.
- `lib/direct.ts` + `routes/direct.ts`: Yandex Direct Reports API v5 (TSV,
  CAMPAIGN_PERFORMANCE_REPORT). Missing token → honest `{configured:false}`;
  201/202 offline reports surface as pending, never cached.
- Nightly cron **`30 2 * * *`** (`lib/web-analytics-sync.ts`): upserts yesterday into
  `web_analytics_daily` (date, source ∈ ga4|metrika|direct) and `web_behavior_snapshots`
  (Clarity daily snapshot). Per-leg try/catch through the `reportCronFailure` auto-healer;
  tables self-create (`CREATE TABLE IF NOT EXISTS`).
- `POST /admin/migrate/web-analytics` (idempotent), `/api/analytics/web-daily` +
  `/api/analytics/behavior-history` D1 readers, integration-health entry
  "Web analytics · nightly" incl. token-expiry watch, `responses.fail` extended to 502/503.

### Phase 4 — Dashboard UI (web/app/analytics/)
Single page → five tabs, distributor-kit patterns recreated in React (kpis grid, kpi
cards incl. inverted accent card, hairline panels, sunk-header tables, status pills),
tokens only, Tremor re-themed (brand-rot/stone marks, token-styled ChartLegend replaces
Tremor's default legend):
1. **Overview** — revenue / sessions / CR / AOV / returning-customer rate (GA4, formulas
   printed), 30d trends, D1 orders marketplace block, nightly-archive status.
2. **Traffic & Sources** — GA4 channels + landing pages; Metrika RU-contour sources,
   phrases with intent badges, money-cluster gap table KEPT from old page, labelled.
3. **Funnel** — absolute counts + step rates, units caveat, low-traffic confidence note.
4. **Behavior** — Clarity signals + dimensions, deep-link to Clarity recordings,
   D1 trend chart (unlocks from night 2).
5. **Campaigns** — Direct column (honest not-configured state) + Ads column
   [PENDING GOOGLE APPROVAL]; ROAS formula-gated, no fabricated numbers.

### Design-discipline follow-up (PR #98)
- Keyboard shortcuts: keys 1–5 switch tabs, documented in-UI (kbd hint in tab bar,
  `aria-keyshortcuts`, tooltips), ignored while typing.
- `.wa-toggle` segmented control: hover lift on the Metrika 90/30 toggle + 44px tap
  floor (`--dx-tap-target-min`), `role=group` + `aria-pressed`.

## Verification (done, not assumed)
- Worker bundle: `wrangler deploy --dry-run` clean; new files pass tsc.
- `next build` passes.
- End-to-end against LIVE APIs via local wrangler dev (env-only secrets, gitignored,
  deleted after): GA4 matched brief baseline (Paid Search 4,752/7d), Clarity matched
  (235 sessions, 32.3% dead-click, kaik.ai 104 referrals), nightly cron test-fired →
  wrote ga4+metrika+clarity rows to D1, direct skipped gracefully.
- All five tabs screenshot-verified in headless Chromium with live data; keyboard
  shortcut exercised (pressed "2" → Traffic & Sources).
- Post-merge prod checks: new endpoints 200 on `dasoperator-api`, D1 tables created via
  admin migration, `dasoperator.pages.dev/analytics` 200.

## Live findings worth knowing
- **Metrika RU contour is NOT ~4 visits/day anymore**: 30d = 7,893 visits / 200
  purchases / 2.53% CR, dominated by "Ad traffic" (6,378). The brief's baseline is stale.
- GA4 .com contour: ~87% Paid Search (VN Google Ads), purchases near zero in 7d window —
  funnel shows heavy drop at add_to_cart → begin_checkout → purchase.
- Clarity: 98% Vietnam mobile, dead-click ~32%, rage-click ~9% — UX debt signals for
  the .com PDPs (recordings deep-linked from the Behavior tab).

## Open / next steps
1. **Yandex Direct token (the only missing credential)** — tested: the Metrika OAuth
   token does NOT carry `direct:api` (Direct API error 53). Owner must authorize once in
   browser: enable `direct:api` on OAuth app `daadca5f...` at oauth.yandex.ru, open
   `https://oauth.yandex.ru/authorize?response_type=code&client_id=daadca5f4b914426870c7bbc047dbd64`,
   pass the confirmation code back → exchange + store as `DIRECT_OAUTH_TOKEN` Worker
   secret. Campaigns tab + nightly Direct leg activate same day, no deploy.
2. **Google Ads** — Basic-access approval pending since 2026-06-11; column activates on grant.
3. **Acceptance clock** — nightly cron must write GA4+Clarity+Metrika rows 14 nights
   straight unattended (starts 2026-07-07 02:30 UTC). Watch via
   `/api/integrations/health` → "Web analytics · nightly" row.
4. **Phase 5 learning loop** (after ~4 weeks of D1 rows) — weekly distill of
   web_analytics_daily + web_behavior_snapshots deltas → canon findings →
   das-architektura/KNOWLEDGE; consumed by seo-master; monthly skeptical pass.
5. **Token watch** — Metrika OAuth expires ~2027-05; GA4 SA key non-expiring but
   rotatable; Clarity ~never. Surfaced in integrations health.

## Where things are
- Code: `dasexperten/dasoperator` main (PRs #96, #98). Branch
  `claude/analytics-dashboard-rebuild-wl4rg5` fully merged.
- Spec: `dasoperator/docs/analytics-parity.md`.
- Design source of truth for /analytics: `dasoperator/web/design-system/`.
- Credentials: SECRETS convention (Worker secrets set on `dasoperator-api`; brief stays
  in SECRETS, nothing committed).
