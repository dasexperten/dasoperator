# UGC separate inactive view

Owner follow-up replaces the default mixed-list behavior: unavailable Instagram accounts stay out of the default list; a single checkbox labelled `Inactive` requests the inactive-only view.

Marika Nowicka accepts this scoped control before publication.

## Frontend behavior

- One unchecked checkbox by default, beside the profile tools and outside the collapsed phone filters. Its count comes from API `inactive_count` when present.
- Checked state requests `inactive=1`, persists in the URL and restores on URL initialization. Unchecking removes the parameter. Cache namespace is v3 and is separated by query parameters.
- Enabling Inactive clears the stage filter and closes any selected creator. Network, search and product filters remain unchanged. Existing faded-row behavior and actions remain available inside the inactive list.
- Client-side row selection checks unavailable Instagram profiles against the checkbox state immediately; old cached or in-flight response data cannot briefly expose active rows in the inactive view or inactive rows in the default view. The checkbox count is the API's global inactive count.
- Changed classes: `ugc-inactive-filter` plus its checkbox and selected/focus states. Current type and palette tokens retained. Checkbox tap label is at least 44 px high; checkbox has a visible keyboard focus outline.

## Native visual evidence

Clearly labelled local synthetic fixture reuses current UGC stylesheet and matching desktop/mobile row structures; this is visual acceptance, not proof of production filtering or API data.

- `.tmp/ugc-row-review/inactive-before-390.jpg`
- `.tmp/ugc-row-review/inactive-default-390.jpg`
- `.tmp/ugc-row-review/inactive-only-390.jpg`
- `.tmp/ugc-row-review/inactive-before-1440.jpg`
- `.tmp/ugc-row-review/inactive-default-1440.jpg`
- `.tmp/ugc-row-review/inactive-only-1440.jpg`

Native viewport sizes: 390 × 844 and 1440 × 900. Default fixture contains only the available row. Checking the sole checkbox exposes only the faded unavailable row. At 390 px the control stays visible, the document has zero horizontal overflow, and the row label, follower count and payment remain readable. The control uses the existing working red token. Viewport override reset after capture.

Frontend TypeScript passed (`tsc --noEmit -p web/tsconfig.json`). Parent task verifies API filtering, real data and deployed runtime after publication.

Commit trailer:

`Look-accepted: Marika Nowicka · separate Inactive checkbox and list; native fixture before/default/inactive 390 and 1440 px; zero mobile overflow`

## Production verification

Merged as PR 192 at `ac4f97e73176d7596bb17e4f4fa372592d3054d3`. API run 39114063720 and Pages run 39114063724 completed successfully; Checks 39114063707 passed. GitHub Contents API returned matching source blobs for the API route and frontend page.

Authenticated live API audit: default Instagram list 690 creators, inactive-only list exactly 19, global inactive count 19, zero overlap and zero unexpected availability states. The inactive list exactly matches the 13 accounts from the previous avatar pass plus six earlier archived accounts whose URLs were rechecked in signed-in Instagram and remain unavailable. Those six retain their archive flags and history.

Native live browser: checkbox initially unchecked and no unavailable rows in the default view. Checking it changed the URL to `inactive=1` and displayed exactly 19 desktop rows, all with unavailable styling. At 390 by 844 px, reload restored the checked URL state; all 19 phone rows were present, the checkbox was outside the collapsed filters at top 252 px, and document width did not overflow. Unchecking removed the inactive query parameter. Viewport reset and active Instagram list left open. Payment, conversation and publication history remained available; no payout or message was sent by this task.
