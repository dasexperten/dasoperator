# Articles mobile revision visual acceptance

Reviewer: Marika Nowicka. Date2026-10-16.

Verdict: ACCEPT actual final v6 component at verified390px and1440px frame widths. Supersedes the prior v5 mobile horizontal-scroll appearance acceptance, following the Owner requirement that title, placement service and link be visible without swipe.

Preview http://127.0.0.1:4316/?v=6 uses the actual component/current production-built CSS and sanitized19-real-placement fixture. This is a native-browser component review, not simulated authenticated production or live API evidence.

## Actual measurements

- Mobile innerWidth390, document scrollWidth375 equals clientWidth375. Table width303 equals wrapper clientWidth303 and scrollWidth303. No table or page horizontal swipe is required.
- Mobile first row: title139px, service104px, link column60px, actual icon link target44x44px. All three appear together; link endsx331 within the375px content viewport. Titles wrap without ellipsis; no clipped glyphs or overlap. Language and date columns are intentionally hidden at600px and below, per the new requested mobile scope.
- Mobile paired filters remain equal129.5px wide and44px high, same top coordinate126.875. Both default labels are All, under their distinct field labels.
- Desktop innerWidth1440, document scrollWidth1425 equals clientWidth1425; all five headers and five row cells remain visible, with19fixture rows. Existing typography/contrast and source ordering preserved.

## Evidence

- preview-evidence/articles-final-v6-390-frame.jpg
- preview-evidence/articles-final-v6-1440-frame.jpg

These are native browser screenshots containing actual measured390/1440 frames, not resized screenshots. The prior v5 files are historical and are not the current mobile appearance.

Scope: .wa-articles-table small-screen column widths/visibility plus preserved paired filters. Full authenticated production shell and API remain a postdeployment verification step; this review does not claim they were exercised.

Commit marker:
Look-accepted: Marika Nowicka - Articles actual390/1440 frames; mobile title/service/44px link visible without swipe, desktop5columns retained.

## Reviewed source hashes

- web/app/analytics/analytics.css: 9d3bc38711ade816d02cfce041115513ecb524747da60bf182774dc0057d5601
- web/app/analytics/tabs/ArticlesTab.tsx: 8eb391d585917a9e50292af84a9479f434a48d4ecafca35ac7f30794d9a20f22
- web/app/analytics/page.tsx: c710a4ef159cf3851ed2c71751fcdc7a7bb4e0418af79d2d98f8de82956aa9f6
