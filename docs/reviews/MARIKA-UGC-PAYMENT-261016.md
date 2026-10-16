# Marika: ready payouts stay brown while data is collected

Owner follow-up, 16 October 2026: remove Engagement rate and do not keep payout buttons grey or inactive because creator statistics or product information could not be collected. Collect that data independently; people are waiting.

Changes:

- Remove ER from desktop and phone columns, the headline KPI and sorting options; keep the remaining table aligned.
- Missing creator data no longer changes a ready payout to grey or disables its button.
- Remove the matching server-side metadata rejection from the execute route. Admin access, requisites, money limits, balances, and duplicate-payment protection continue through the existing execution service.
- Keep metadata gap annotations for enrichment, without ER as a required field. Background metrics collection also includes sent and paid payouts, so payment does not remove the creator from collection eligibility.

Before/after inspected at 1440 and 390 px. Brown payout controls render on rows without followers; ER is absent and the phone layout has no horizontal overflow. TypeScript and 48 payout tests passed. No payment was executed as part of verification.

Live verification and deployment references are recorded on task `INC-MARIKA-UGC-PAY-261016`, run `10151`.

Production code: `b1775d5e3d342b2f0dc5a7b241598e84f99bb023`. Both [Pages](https://github.com/dasexperten/dasoperator/actions/runs/38901863565) and [API Worker](https://github.com/dasexperten/dasoperator/actions/runs/38901863341) deployed successfully. Live verification: eight enabled brown payment buttons in each layout, zero payment badges blocked by missing creator data, no ER column/KPI/sort option. Desktop 1440 px and phone 390 px have no horizontal page overflow. No execute request was sent for verification.
