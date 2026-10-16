# Roberta Di Maria: Articles functional and wording review

Date:16October2026. Actual code review requested by Julian for the Owner's ERP Analytics Articles feature. Verdict: ACCEPT for the reviewed functional/content scope. No browser rendering, visual acceptance, deployment or live data validation claimed.

Reviewed web/app/analytics/tabs/ArticlesTab.tsx, api/src/lib/article-placements.ts, GET/articles in api/src/routes/analytics.ts, parent analytics page integration, relevant CSS and the five existing projection tests.

The Articles table has exactly five columns: article title, service, language, one external link icon, publication date. Titles are preserved. Known service domains project to short names such as Teletype, Amwaly and Tumblr without domain or account suffixes. Language codes are uppercase two letters; VI is normalized to VN. Link cells contain one icon with accessible descriptive labeling. Dates from timestamps use the Yerevan calendar day; date only records retain their recorded day.

There are exactly two local filters, service and language, both derived from publication rows. The table has no extra explanatory prose. Parent page explanatory paragraph and help footer are hidden for the Articles section. Ordinary table headers, control labels, empty state and load/error states remain useful interface text rather than explanatory content.

The API reads the organization publication ledger on main and returns only the five publication fields. No account email, access notes or credentials are projected. Draft, submitted, pending and private records are excluded. The route reports source errors rather than a false successful empty list. HTTPS, same recorded domain and no embedded credentials are required for links; duplicate URLs are suppressed. This content gate does not establish public accessibility of a URL; ledger evidence remains Julian's responsibility.

Validation performed in the feature worktree: node --test api/src/lib/article-placements.test.mjs. Result:5passed,0failed. Covered field privacy and Yerevan dates, publication state exclusion, safe platform links, VN/subdomain/deduplication/date only behavior, invalid record omission and malformed ledger failure.

The service mapping covers current named services. Unknown future services use the ledger service string; future record authors must retain the Owner's short platform name requirement. No new policy or release gate introduced. Visual typography, actual browser behavior and final main/deployment checks belong to the corresponding reviewers and Julian.
