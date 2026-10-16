# UGC publication product correction — 16 October 2026

The Owner reported that products were still undefined. The earlier full workbook
reconciliation populated account product history but did not classify the exact
publication observations. Their `product_status` and the 696-item queue remained
unchanged. This was an incomplete implementation of the request.

## Correction

`tools/plan-ugc-publication-products.mjs` matches the original workbook sheet,
row, creator/profile id and exact publication URL. It restores explicit products
from N:R and the omitted S text field to 591 observations: 439 have canonical
products (224 newly identified); 152 contain a family name without a supported
subtype. A product from another post or account order is never copied into a
publication. Existing raw offer identifiers and manual/vision decisions remain.

The XLSX importer now sends S as `product_text`; the API classifies this text on
future imports. Publication cards show source-backed product names or the actual
family with “тип не указан”. The main table also reads products explicitly
entered on a payout's own profile, and its product filter uses the same evidence.
No payout amount, approval, execution or paid counter is changed.

## Limited external verification

Native web fetches could not read Instagram. A 20-publication extraction was
tried via apifier. `apidojo/instagram-scraper` returned no results; the capable
fallback `apify/instagram-scraper`, run `w3tkmE9ztCERaqpqh`, returned 12 readable
posts and 8 unavailable responses. Exact WB article mappings from the live ERP
stock mapping disambiguate 271980094 → DE210 and 313250836 → DE310. Of those
12 posts, 9 are INNOWEISS toothpaste and 1 is INNOWEISS mouthwash. No model is
guessed from a promo code, generic image, or unknown article 3497962138.

The Owner chose **“Пока использовать найденные данные”**. No expanded external
collection is authorized or launched. The data service did not expose actual
billing; the reported fallback cost was explicitly an estimate (~USD 0.05).

`tools/plan-ugc-caption-products.mjs` joins exact Instagram media ids (reel/post
URL forms) and checks the author's handle. It plans 19 observation updates,
including 10 canonical classifications and 9 explicit unresolved outcomes.
Three duplicate observations of one other post have a source-handle/owner
mismatch (`cometolog__patyulya` / `cosmetolog___patyulya`); they remain unchanged.
One additional profile reference for gr.y.ser is supported by the creator's own
archived caption naming TERMO 39°C (thread-0064, item 6, with the reel link).
It is profile history, not a classification of a different publication.

A metadata reference resolves an ambiguous family only at the same publication
URL and profile. Another post's family remains ambiguous. Unavailable posts do
not erase existing canonical products. Private inputs and captions stay outside
GitHub; live source facts retain provenance in ERP.

## Validation

42 focused Node tests pass, including exact-row/URL and owner boundaries,
paste versus mouthwash WB mapping, ambiguous article protection, raw pack ids,
family-only evidence, payout-specific profiles, source priority and payment
execution safeguards. Web TypeScript passes. Full API TypeScript has existing
errors outside the modified UGC modules; no modified UGC module errors were
reported. The worker bundle dry run passes. Production readback follows release.
