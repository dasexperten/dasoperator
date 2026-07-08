# Analytics Parity Spec — Wix + Shopify dashboard set → own sources

> Phase 1 of the Web Analytics Command Center (2026-07-06).
> Wix and Shopify are a **functional spec only** — their public dashboard catalogs define
> WHAT a standard e-commerce analytics suite shows. Neither platform is connected.
> Every metric below maps to one of OUR sources. `NONE` rows are **cut honestly** —
> they are never faked or approximated in the UI.

## Sources legend

| Code | Source | Contour | Status |
| --- | --- | --- | --- |
| `GA4` | Google Analytics 4, property 511756146, Data API v1beta | Global (.com), ~5,450 sessions/7d, 87% Paid Search | LIVE |
| `CLARITY` | Microsoft Clarity Data Export API | Global (.com), ~233 sessions/day, 98% VN mobile | LIVE — **max 3-day window, 10 calls/day; D1 accumulation is the only archive** |
| `METRIKA` | Yandex Metrika counter 107720199 | **RU contour** (dasexperten.ru), ~4 visits/day | LIVE |
| `DIRECT` | Yandex Direct Reports API v5 | RU paid | **PENDING — no OAuth token yet; UI ships `configured:false`** |
| `ADS` | Google Ads API v21 | Global paid (VN campaigns) | **BLOCKED — Basic-access approval pending since 2026-06-11** |
| `D1` | Own orders/sales tables in D1 `das_erp_dev` (marketplace sales, site settlements) | All | LIVE |
| `NONE` | No honest source — metric is CUT | — | — |

**Blend rule:** GA4, Clarity and Metrika see three different volumes (geo + consent + sampling).
Every dashboard tab labels its data source. Metrics are never blended across trackers without
an explicit formula note in the UI.

## Shopify Analytics catalog → our mapping

Catalog source: Shopify Help Center — Analytics overview dashboard + report categories
(Finances / Acquisition / Behavior / Customers / Sales attribution).

| # | Shopify metric / report | Our source | How | Dashboard tab |
| --- | --- | --- | --- | --- |
| S1 | Total sales (over time) | GA4 | `purchaseRevenue` by date (`runReport`) | Overview |
| S2 | Sessions / visitors | GA4 | `sessions`, `totalUsers` by date | Overview |
| S3 | Online store conversion rate | GA4 | purchases ÷ sessions (formula noted in UI) | Overview |
| S4 | Total orders | GA4 | `ecommercePurchases` (labelled "GA4 purchases", not D1 orders) | Overview |
| S5 | Average order value | GA4 | revenue ÷ purchases (formula noted in UI) | Overview |
| S6 | Returning customer rate | GA4 | `newVsReturning` dimension × purchases; labelled GA4-defined | Overview |
| S7 | Conversion funnel (sessions → product → cart → checkout → purchase) | GA4 | event counts: `page_view`, `view_item`, `add_to_cart`, `begin_checkout`, `purchase` | Funnel |
| S8 | Top products by units sold | D1 | marketplace sales tables (Ozon/WB per-SKU 30d) — labelled marketplace contour, site per-product sales not tracked | Overview (marketplace block) |
| S9 | Sessions by traffic source / acquisition reports | GA4 | `sessionDefaultChannelGroup`; RU contour separately via METRIKA `lastTrafficSource` | Traffic & Sources |
| S10 | Sessions by landing page | GA4 | `landingPage` dimension | Traffic & Sources |
| S11 | Sessions by device / location | GA4 + CLARITY | GA4 for sessions split; Clarity device/geo for behavior split (labelled separately) | Behavior |
| S12 | Sales attribution / ROAS by campaign | DIRECT + ADS | Direct: Reports API when token filled; Ads: pending Google approval. Both graceful-degrade | Campaigns |
| S13 | Customer cohort analysis / one-time vs repeat customers | NONE | **CUT** — no cross-session customer identity in own stack (no CRM join for .com yet) | — |
| S14 | Abandoned checkouts (list of carts) | NONE | **CUT** — GA4 gives `begin_checkout` minus `purchase` counts (Funnel), but no per-cart records exist | — |
| S15 | Inventory / fulfillment reports | D1 | already live elsewhere in ERP (/marketplaces, /warehouses) — not duplicated in /analytics | — |
| S16 | Finances summary (payments, taxes) | D1 | already live in ERP /finance from bank settlements — not duplicated | — |
| S17 | Live View (real-time) | NONE | **CUT** — GA4 realtime API out of scope for nightly-refresh design | — |

## Wix Analytics catalog → our mapping

Catalog source: Wix Help Center — Traffic / Sales / Behavior overviews, Reports glossary,
Real-time analytics.

| # | Wix metric / report | Our source | How | Dashboard tab |
| --- | --- | --- | --- | --- |
| W1 | Site sessions (over time) | GA4 | `sessions` by date | Overview |
| W2 | Unique visitors, new vs returning | GA4 | `totalUsers`, `newVsReturning` | Overview |
| W3 | Sales overview (revenue, orders, AOV) | GA4 | as S1/S4/S5 | Overview |
| W4 | Sales by traffic source | GA4 | channel group × purchases/revenue | Traffic & Sources |
| W5 | Traffic sources / categories | GA4 + METRIKA | GA4 channels (global) + Metrika sources (RU, kept & labelled) | Traffic & Sources |
| W6 | Top pages | GA4 + CLARITY | GA4 landing pages; Clarity `PopularPages` (labelled per source) | Traffic & Sources / Behavior |
| W7 | Sessions by device / country | CLARITY | `Device`, `Country` blocks (1-day live insight, archived nightly to D1) | Behavior |
| W8 | Average pages per session, session duration | METRIKA | RU contour only (`avgVisitDurationSeconds`); GA4 engagement not pulled in v1 — noted in UI | Traffic & Sources (RU block) |
| W9 | Bounce rate | METRIKA | RU contour only, labelled; Clarity `QuickbackClick` is the closest .com proxy (labelled, not blended) | Behavior |
| W10 | Top clicks / element engagement | CLARITY | dead-click %, rage-click %, quickback % (Clarity's element-level click map is deep-linked, not re-rendered) | Behavior |
| W11 | Scroll depth / engagement time | CLARITY | `ScrollDepth`, `EngagementTime` | Behavior |
| W12 | Session recordings / heatmaps | CLARITY | deep-link to clarity.microsoft.com project (recordings not embeddable) | Behavior |
| W13 | Referrers | CLARITY + GA4 | Clarity `ReferrerUrl` (1d), GA4 channel/source (window) | Behavior / Traffic |
| W14 | Top search phrases (SEO) | METRIKA | existing `/api/metrika/phrases` (RU contour, kept) | Traffic & Sources |
| W15 | Real-time analytics / AI-platform sessions | NONE | **CUT** — nightly-refresh design; no realtime leg | — |
| W16 | Contact/form submissions, bookings | NONE | **CUT** — no form product on .com | — |
| W17 | Email / marketing campaign reports | NONE | **CUT** in /analytics — email ops live in ERP /emailer | — |
| W18 | Top navigation flows (4-step Sankey) | GA4 | pairwise version: `landingPage` entries + internal `pageReferrer → pagePath` transitions (`/api/ga4/nav-flows`); full session paths need the BigQuery export — method note in UI | Behavior |

## Paid-media legs (both catalogs' "marketing/attribution" sections)

| Leg | Source | State shipped in v1 |
| --- | --- | --- |
| Yandex Direct campaigns (spend, clicks, conversions) | DIRECT | Route + UI column ship now; render "not configured" until `DIRECT_OAUTH_TOKEN` Worker secret is set. Activates same day the token lands. |
| Google Ads campaigns (spend, clicks, conversions, ROAS) | ADS | UI column ships in `[PENDING GOOGLE APPROVAL]` state; no fabricated data. Activates when Google grants Basic access. |
| ROAS (spend vs revenue) | DIRECT/ADS + GA4 | Computed only when a spend source is live; formula note in UI (spend source ≠ revenue source). |

## Nightly archive (what D1 accumulates)

| Table | Fed by | Grain |
| --- | --- | --- |
| `web_analytics_daily` | GA4 (yesterday), Metrika (yesterday), Direct (when configured) | (date, source) — sessions, users, purchases, revenue, cr, aov |
| `web_behavior_snapshots` | Clarity `numOfDays=1` — **exactly 1 API call per night** (hard limit 10/day) | date — sessions, bot %, dead/rage/quickback %, scroll, engagement, top pages/referrers/countries/devices JSON |

No historical backfill exists for Clarity — the nightly D1 accumulation IS the archive.

## Done-criteria trace

- Every Shopify overview-dashboard metric and every Wix overview metric is either mapped
  to a live/pending own source or explicitly CUT with the reason.
- CUT list (honest): S13 cohorts, S14 abandoned-cart records, S17/W15 realtime,
  W16 forms, W17 email (lives elsewhere), S15/S16 duplicated ERP reports.
