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
