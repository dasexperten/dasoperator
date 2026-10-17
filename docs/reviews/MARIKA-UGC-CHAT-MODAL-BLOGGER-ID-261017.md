# UGC: Direct links, modal cards and independent profile worker

Owner decisions on 17 October 2026 replace the earlier status-to-card interaction: status opens the blogger's Instagram conversation; row whitespace opens the blogger card in a modal. Profile enrichment has its own `erp-blogger-id` worker and manual controls.

## Live interaction verification

- `replied` for `poll1inaa` opened `https://www.instagram.com/direct/t/109558843767596` in a new tab. Instagram showed the signed-in `dasexperten` account and the correct recipient. The username-based Direct resolver was also checked for Zalina, opening thread `100451091356976`.
- Clicking the actual follower text did not open a card. Clicking row whitespace opened a native modal dialog. Desktop main scroll remained **41.5 → 41.5**, mobile **0 → 0**. Existing profile links, publication links and payout controls retain their actions.
- Card closes with Escape or its close button. Native modal focus and background interaction protection are used. No inline card or `scrollIntoView` remains.
- Desktop final dialog: centered, width 960, top 16. At 390×844: width 374, left/top 8, internal scrollWidth equals clientWidth (372), avatar loaded, explanatory text wraps. Temporary viewport override reset.
- Final screenshots: `/private/tmp/marika-blogger-modal-desktop-261017.png` and `/private/tmp/marika-blogger-modal-mobile-261017.png`.

## Independent profile enrichment

- `erp-blogger-id` owns cron **`0 23 * * *` = 03:00 Asia/Yerevan**. Live Cloudflare schedule read back and matched. Its run secret is provisioned from the existing vault reference; no credential is committed. Unauthenticated manual run returns 401; health returns 200 with a successful last run.
- Removed profile measurement from the payout lane. This worker neither executes payments nor reads/sends Direct messages. It reads existing message sender IDs solely to identify a profile for the official profile API.
- Official Instagram profile API supplies matched-username follower counts and avatars. Public profile/post metadata supplies available publication counts and ER. ER uses up to six newest dated available posts: mean(likes + comments) / followers × 100; sample size and a separate observation date appear in the card. Missing new data preserves prior observations and their ER date.
- Real avatars are downloaded only from validated Instagram/Meta CDN hosts, with bounded size and validated redirect targets, then retained in the private DOCS bucket. The ERP avatar endpoint requires UGC access.
- Card manual control refreshes one account; toolbar manual control refreshes the next small batch (2). Nightly processing handles up to 20 eligible accounts with a time budget. New/unmeasured profiles are prioritised. The global profile-job lease prevents overlapping profile batches without affecting payouts or Direct.
- First real independent manual worker run: **20 attempted, 20 updated**, successful, 282405 ms. It stored **19 avatars**, publication counts for **10** profiles and fresh ER samples for **4**. These are partial-field successes, not a claim that every metric was available.
- Card's separate manual refresh of Zalina succeeded: **9361 followers**, real avatar, prior ER retained with its earlier date; current payout remains **627 ₽**, product **210**. Including this refresh: 21 profiles attempted and 20 cached avatars. No message or payment was sent during verification.

## Sources and deployment

- Implementation `2da3750e4a50e477b1172e2f8efa251d33cc90a5`; API deploy **39018482623**, timer deploy **39018482601**, profile migration **39018489577** all successful.
- Modal layout correction `283be1bad1e539bdb06b62fe2dada9a639719ab8`; Pages deploy **39018818083** and Checks **39018818134** successful.
- 35 focused profile/Direct/payout checks passed; frontend TypeScript passed; worker/schedule guard passed. Added profile parsing and Direct-link checks to CI. Full API TypeScript still reports unrelated existing diagnostics; no remaining diagnostics were reported for the changed profile/UGC modules. Migration fixture preserved existing follower counts and ER dates.
