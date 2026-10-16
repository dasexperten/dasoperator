# Marika: fill follower counts from the linked profiles

Owner follow-up, 16 October 2026: open the account, read its follower count, and write it to ERP. Missing statistics must not delay payment.

Checked 181 initially missing profile rows through the native browser and saved 141 available counts to `ugc_creator_platforms`. All 141 saved values were read back and matched to the recorded observations. Fields updated: followers, metric observation date, update timestamp. No payment was executed.

| ERP platform | Rows filled |
| --- | ---: |
| Instagram | 103 |
| Other, using the existing Instagram profile link | 32 |
| Telegram | 2 |
| TikTok | 2 |
| YouTube | 2 |

Instagram values came from the exact public follower title, including the singular `1 follower` case. One YouTube value is the site's rounded `33.3K` display, recorded as 33300 with its precision identified in the evidence. The other YouTube value is 247; Telegram counts are 23 and 442; TikTok counts are 8 and 22.

Unfilled rows: 31 unavailable profile links, five Telegram personal contacts without a public subscriber count, two Telegram handles resolving to the general landing page, one VK profile blocked by the browser site-safety policy, and one internal Owner payment test account. No alternate route was used to bypass the VK browser restriction.

The existing `Other` row links are constructed as Instagram URLs by `profileHref` in the UGC page; their platform classification was not changed. Duplicate linked accounts may occur in different ERP rows, so 141 is a count of filled rows, not distinct people. New arrivals during this live session are outside the initial scan snapshot.

[Per-row evidence](MARIKA-UGC-FOLLOWERS-261016.csv) includes profile URL, observation time, public counter precision and outcome. Task `INC-MARIKA-UGC-FOLLOWERS-261016`, run `10152`.
