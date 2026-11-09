# workers/_promozon

Owner 2026-11-08: `erp-promozon` is a read-only boosting and same-cutoff order monitor.
The legacy stock activation and CPC bid restoration implementation is removed.

Every Ozon catalog position appears, including positions without active promotions.
Membership and quarantine come from complete v2 promotion pages. Elastic support
uses product current_boost; other actions can use only the explicit official
description phrase for search/category boosting. Levels never add together.
Future actions do not count as active. Missing values remain unknown.

FBO v3 and FBS v4 order pages are read for yesterday and today. Client quantities
exclude cancellations and identified marketplace buyouts, returned separately.
Both windows share one captured cutoff in Asia/Yerevan. This is ordered units,
not paid sales, payout or profit. Later cancellations can change previous counts.

The full report is saved in ERP crm_sync_state at ozon:promotion-monitor:latest.
GET /api/cron-runs/promozon reads it; ?refresh=1 captures a fresh read-only report.
The existing 4-hour timer remains. Strategies, quantity tiers and individual
price exceptions not established by these reads are explicitly not verified.

Owner 2026-11-09: the same report also reads `hits_tocart` for exact Ozon
source SKU/day pairs and preserves pack variants. Basket periods are Moscow
calendar days: yesterday and the day before yesterday, both complete days,
explicitly labeled separately from same-cutoff Yerevan orders. The basket delta
compares yesterday against the day before yesterday. Missing source mappings, a missing
whole day, incomplete pages or source errors are never converted to shop-wide
zero counts. Last good data for the exact same date pair can be shown with its
timestamp and stale status; an older pair is never relabeled. The completed-day
cache uses a distinct key so old partial-day snapshots cannot be reused.
The basket snapshot and atomic attempt timestamp share ERP D1 across manual and
scheduled refreshes, respecting Ozon's one-request-per-minute analytics limit.
