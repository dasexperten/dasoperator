# Articles in Analytics

The Articles section lists published article placements from the organization ledger on `main`. Open `/analytics?section=articles` or choose Articles in Analytics.

The table contains the article title, short placement service name, two-letter language code, one external link icon and placement date. The service and language filters combine. Both controls remain side by side on narrow screens. The five-column table scrolls within its panel on mobile.

`GET /api/analytics/articles` reads `dasexperten/organizacia/jobs/julian-brand-seeding/PLACEMENTS.json` through the existing server-side `ORG_SSOT_TOKEN`. The ledger remains the source of truth; ERP does not duplicate its records in D1. Responses contain only the five publication fields and are cached for 60 seconds. Timestamps use the Yerevan calendar day; date-only records keep their date. Vietnamese is displayed as VN.

Draft, submitted, pending and private records are omitted. Missing source access and upstream failure return an error instead of an empty successful table. HTTPS links must belong to the recorded platform and cannot contain credentials. Being listed records a publication; it does not prove search ranking, traffic or AI citation.

Validation: seven projection/route tests and two existing stock-source tests pass. The production Next build passes compilation, lint and type validation. The full API typecheck has 402 existing errors on the unchanged baseline and 402 with this feature, with no added diagnostics. The article tests run in the shared deployment guard.

Functional review: [Roberta](reviews/2026-10-16-roberta-articles-analytics.md). Visual acceptance and production verification are recorded separately with their actual scope.
