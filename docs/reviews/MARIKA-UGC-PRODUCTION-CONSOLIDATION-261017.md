# UGC: production consolidation, 17 October 2026

Owner requested that everything agreed in this conversation be merged into production. The audit found no outstanding code changes in this task's worktree: the agreed implementation is already on `origin/main` and deployed.

## Confirmed production scope

- Compact UGC header and summary; Import XLSX, Link health and Engagement rate controls/column are absent.
- Brown payment badges show the amount of their individual payout row. Historical registry totals and paid totals are separate. Enrichment does not disable a ready payment.
- Live `zalina.alkhsv_obzor`: enabled brown **627 ₽**, 9361 followers. D1 confirms payout `ugc_recovered_501088175a22f04887f06b9a`, amount_minor 62700, awaiting_approval, no Konsol payment id. Historical 1611 ₽ is not added. No payment was executed by this audit.
- The responder uses exactly four current scenario cards (`scenario-thermo-261017e/card1.png` through `card4.png`). The current menu replaces the rejected scenario wording; earlier menus are overridden.
- Incoming screenshots reach vision as image bytes; attachment refresh and private caching preserve readable images after CDN expiry. Complete current text can support requisites when an older image is unavailable, with explicit grounding checks. Latest main also includes the browser User-Agent correction for Meta image downloads.
- Failed technical replies remain pending for retry/review. No blind screenshot acknowledgement is permitted. This audit sent no messages to bloggers.
- Previously recovered payments, follower updates, source-product mappings and creator-registration fixes remain in production. New main also refreshes Instagram creators beyond paid accounts and captures reel links from Direct.

## Deployment evidence

- API/timer source: `bb929fff6373038d4936d99941330ffcb6df56a2`; GitHub Actions Deploy Worker **39015125146**, timer workers **39015125268**, Checks **39015125086** all successful.
- Frontend: Deploy Pages production **38968474599**, source `5dce2649f378cb76968763b37e89d7708b00957e`, successful. The entire `web/` tree is unchanged between that deployed commit and audited main.
- Focused payout, attachment, reply and refresh checks: **39 passed, 0 failed** on audited main.
- Native Chrome production check confirmed the compact page, removed controls, current follower count and enabled brown amount. Screenshot retained locally at `/private/tmp/marika-ugc-production-261017.png`.

## Data gaps remain visible

Deployment does not mean all source data is known. The live page still reports **313 queued products**. At this audit, 45 platform profiles had unknown follower counts, including 23 Instagram profiles; this is a changing backlog, not a claim that all 45 are permanently unavailable. Product mappings exist for 407 distinct creators in source records. Current-basket products are not inferred from historical account products.

The older Zalina screenshot could not be recovered from the checked sources, as documented in `MARIKA-IG-IMAGES-ZALINA-261017.md`. The prior three-image runtime proof and current regression checks do not establish that this specific older screenshot was read.

No additional runtime code change or redundant deployment was needed for this consolidation. The current-payout display rule is recorded here explicitly: **one brown button, one payout id, that payout's exact amount**.
