# Marika: ready payouts stay brown while data is collected

Owner follow-up, 16 October 2026: remove Engagement rate and do not keep payout buttons grey or inactive because creator statistics or product information could not be collected. Collect that data independently; people are waiting.

Changes:

- Remove ER from desktop and phone columns, the headline KPI and sorting options; keep the remaining table aligned.
- Missing creator data no longer changes a ready payout to grey or disables its button.
- Remove the matching server-side metadata rejection from the execute route. Admin access, requisites, money limits, balances, and duplicate-payment protection continue through the existing execution service.
- Keep metadata gap annotations for enrichment, without ER as a required field. Background metrics collection also includes sent and paid payouts, so payment does not remove the creator from collection eligibility.

Before/after inspected at 1440 and 390 px. Brown payout controls render on rows without followers; ER is absent and the phone layout has no horizontal overflow. TypeScript and 48 payout tests passed. No payment was executed as part of verification.

Live verification and deployment references are recorded on task `INC-MARIKA-UGC-PAY-261016`, run `10151`.
