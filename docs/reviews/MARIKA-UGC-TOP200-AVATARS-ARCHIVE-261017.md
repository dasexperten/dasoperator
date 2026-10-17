# UGC: top 200 Instagram avatars and unavailable-page archive

Owner requests on 17 October 2026: fill avatars for the first 200 Instagram accounts ordered by ERP activity, prioritising the last ten days; remove confirmed unavailable pages from the active base.

## Verified live result

- Initial Instagram base: 698 profiles. Only 68 had ERP activity within the rolling ten-day window; they were prioritised, then the remainder of the first 200 by the existing ERP recent-activity order.
- Initial top 200: 60 avatars, 140 missing. First pass saved 133 images; `_saniyat93` supplied a real profile picture through the signed-in native browser after the server-side profile read failed.
- Six exact stored profile URLs were confirmed unavailable in the signed-in native Instagram browser and archived. Their existing identity notes, lifecycle status, payouts and content records were retained. This records that those stored URLs are unavailable; it does not establish deletion of an Instagram account or a change of human identity.
- After archiving, six newly promoted accounts entered the top 200. All six received real avatars.
- Final production snapshot: **200/200 active top-ranked Instagram profiles with avatars**, including **68/68 with activity in the last ten days**. **140 additional avatars** saved overall.
- The authenticated ERP avatar endpoint was read for every final profile: **200 HTTP-success responses, 200 nonempty images with valid JPEG/PNG/WebP signatures**. No base64 data or signed CDN URL is committed.
- D1 readback confirmed that all final 200 profiles are active and have cached avatar keys. Comparing all 200 original records against their baseline found **zero changes** to follower counts, post counts, ER values/samples/dates, metric timestamps, profile-attempt/check timestamps or errors during this avatar backfill.

## Archived exact URLs

- https://www.instagram.com/su.nnat891/
- https://www.instagram.com/cometolog__patyulya/
- https://www.instagram.com/s3vinc06/
- https://www.instagram.com/avazova.nastya/
- https://www.instagram.com/a.winhester/
- https://www.instagram.com/sum.sap1/

The default ERP query excludes archived creators. The collaboration-stage filter now includes **Архив**, and the modal provides **Вернуть в активные**. This is independent of lifecycle/payment state. Existing imports preserve the archive flag, and profile/statistics enrichment skips archived creators. No payment was executed or Direct message sent by this work.

Native ERP verification found all six archived rows under the archive filter, with existing source/payment history visible and restoration control present. Searching `su.nnat891` in the default active view returned no creators. Desktop visible active rows decoded their real images. At 390 x 844 the modal had zero horizontal overflow; its archive/save controls wrap within the card. Viewport override reset; the active Instagram ERP list left open.

## Implementation and deployment

- Avatar-only refresh: `b2d020e42400f7bf0d4be4811498787ce0b8860d`; API deploy **39022925860**, Checks **39022925874** succeeded. It reuses trusted-CDN, size/content-type and redirect validation, without reading posts or advancing dates on retained metrics.
- Archive migration 0132: `4fdc8af7fce355d616a87370ac95a40464eb200b`; live migration run **39023356776** succeeded. Nullable `ugc_creators.archived_at` and its index were read back.
- Archive and browser-observed-avatar support: `f6cb71812925da448c3efa435672d39731acf68e`; API **39023471142** and Pages **39023471144** succeeded. Optional-field typing correction `5386a751205f8504c211756e04475aba65df27fa`; API **39023498763** and Checks **39023498809** succeeded.
- Mobile archive controls: `e332de82e65c29148a359573e230f9bbc3635e21`; Pages **39023687469** succeeded.
- Frontend TypeScript passed; no API TypeScript diagnostics remain for changed modules (unrelated existing API diagnostics remain elsewhere). Eight focused parsing/avatar-only tests passed; actual route SQL was exercised in SQLite for active exclusion, archive lookup, restoration and preserved history. Private-image readback and production UI verification passed.

## Local evidence

- Baseline: `/private/tmp/marika-ugc-top200-cohort-before-261017.json`
- Final cohort: `/private/tmp/marika-ugc-top200-after-261017.json`
- Authenticated image audit: `/private/tmp/marika-top200-avatar-readback-261017.json`
- Native unavailable-page evidence and archive audit: `/private/tmp/marika-top200-instagram-native-evidence-261017.json`, `/private/tmp/marika-top200-archive-audit-261017.json`
- Live screenshot: `/private/tmp/marika-ugc-top200-avatars-live-261017.png`

[Open the active Instagram ERP list](https://erp.dasexperten.com/ugc?platform=instagram)
