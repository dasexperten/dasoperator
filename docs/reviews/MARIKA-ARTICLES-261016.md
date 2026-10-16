# Articles component visual acceptance

Reviewer: Marika Nowicka. Date: 2026-10-16.

Verdict: ACCEPT the new Articles component and its scoped classes after actual native browser inspection of final local preview v5.

## Scope and provenance

Preview: http://127.0.0.1:4316/?v=5 . Actual ArticlesTab bundled with actual Next production CSS and a sanitized fixture of 19 real ledger placements. Native browser frames verified actual innerWidth390 and1440. This is an isolated component review, not an authenticated production page or API test. Existing Analytics shell is unchanged except adding the Articles tab. Full authenticated production chrome must be checked after deploy; it has not been represented as verified here.

Affected classes: .wa-article-filters, its label/select descendants, .wa-articles-table and scoped dx-keep-table mobile descendants, .wa-article-link including hover/focus. Existing .wa-panel, .wa-table and .wa-table-scroll are reused. No global table style was changed.

## Actual final observations

| Check | Actual result |
| --- | --- |
| Frame widths | innerWidth390 /1440 |
| Document width | mobile scrollWidth375 equals clientWidth375; desktop1425 equals1425 |
| Filters | exactly2, side by side at both widths, gap12px |
| Mobile selects | equal129.5px width,44px height,16px text; default All fully visible |
| Desktop selects | equal220px width,44px height |
| Table | exactly5 columns; title wraps; service/language/date stay unbroken |
| Mobile overflow | table700px inside303px wrapper, no page horizontal overflow |
| Table groups | native table-header-group and table-row-group, aligned columns |
| Links | one external-link SVG per row,19 links for19 fixture rows;44px targets |
| Keyboard focus | native SELECT focus-visible outline2px working red, offset2px |
| Combined filters | Teletype plus RU shows exactly the one Russian placement |
| Encoding | corrected German Zahnbuerste spelling uses the actual Unicode umlaut in the rendered title, Russian and Vietnamese glyphs render |
| Type | table14px/700, labels/selects inherited600; normal tracking, no introduced second font family |
| Contrast | body18.02:1 on white; header8.67:1 on its paper background; working-red icon5.84:1 on white |

Initial mobile preview inherited stacked card cells and later exposed an absolute hidden header causing page overflow. Final scoped table corrections preserve the requested five-column list. Owner's paired-filter correction is applied; longer default labels were shortened to All under their existing field labels to avoid clipping.

## Evidence

- preview-evidence/articles-final-390-frame.jpg: native screenshot with actual390px frame visible, final v5.
- preview-evidence/articles-final-1440-frame.jpg: native screenshot with actual1440px frame visible, final v5.
- preview-evidence/articles-before-filter-grid.jpg: historical before comparison, not final appearance.

Screenshots are full native browser captures containing explicitly labelled frames, not resized desktop screenshots passed off as mobile views.

Suggested commit marker:

Look-accepted: Marika Nowicka - Articles component actual390/1440 frames, paired44px filters,5 columns, internal mobile scroll; production shell verification follows deploy.

## Reviewed source hashes

- web/app/analytics/tabs/ArticlesTab.tsx: 1e918c6fe6740e5a8b9cd6100d0dedf8efac32ca2ad193969c296497cc870ad1
- web/app/analytics/analytics.css: 2efdb98994b204d9e667be83b81d7d9e2315f312f0b4d64ae94c2c95e8047fe6
- web/app/analytics/page.tsx: c710a4ef159cf3851ed2c71751fcdc7a7bb4e0418af79d2d98f8de82956aa9f6
