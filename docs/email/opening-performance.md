# Marika: mail opening performance

## Scope and current deployment

The goal is faster opening of the ERP Emailer and individual messages. Google
remains the permanent mail store. Measurements below are not a claim that the
entire ERP page opens six times faster.

Production changes verified through successful deployment runs:

- `51d18fe`: shared, identity-checked Google authorization for concurrent requests;
  reuse is limited to two minutes and shortened by token expiry. ERP authorization
  still runs on every request. Counters start after the first list request completes.
- `fb793ed`: one metadata batch for the 25 inbox or draft summaries, replacing
  individual metadata transports. Google quota accounting remains per inner request.
- `f4e5f20`: mouse dwell and keyboard focus prepare a message after 120 ms. The click
  shares that pending download. Only one speculative download starts at a time;
  speculative reads never mark messages read. The per-component cache holds at most
  16 bodies smaller than 500,000 text/HTML characters each, expires after 60 seconds,
  and clears on account change, refresh, retry and component unmount.

## Live Google comparison

Read-only comparison on the same 25 messages, alternating execution order.
All three trials returned equivalent metadata. Times are milliseconds measured
from this workstation, not from the production Worker or the browser rendering path.

| Trial | Individual requests, concurrency 5 | Batch request |
| --- | ---: | ---: |
| 1 | 4093 | 634 |
| 2 | 3347 | 530 |
| 3 | 3095 | 566 |
| Median | 3347 | 566 |

The metadata transport stage took about 83% less time in this sample. No email
was sent, modified or imported by the comparison. Message content and credentials
are excluded from this document.

Reference: https://developers.google.com/workspace/gmail/api/guides/batch

## Automated verification

- `node tools/tests/gmail-metadata-batch.mjs`: response ordering, boundaries,
  missing/duplicate/wrong IDs, provider errors and page limits.
- `node tools/tests/gmail-session.mjs`: eight concurrent calls share two Google
  authentication requests instead of sixteen; expiry, credential rotation,
  account checks, failure recovery and explicit invalidation.
- `node tools/tests/mail-body-cache.mjs`: hover/click coalescing, account separation,
  late-response invalidation, failed-request retry, size limit, eviction and expiry.
- Frontend TypeScript check passed for the deployed cache integration.

## Outstanding end-to-end evidence

Computer-use discovery currently returns no applications or browsers and reports
`Sky Computer Use native pipe startup failed`. Consequently, the following remain
unmeasured and completion of the speed goal is not proven:

1. Cold navigation to `/emailer`: click/navigation to first usable message list.
2. First message open: click to visible body and enabled reply controls.
3. Hover-prepared open and repeated open: visible latency and absence of duplicate
   body requests, including keyboard navigation and mobile touch behavior.
4. Refresh/account switch after caching: fresh content without displaying another
   account's message. Preserve any pre-existing unsent draft during checks.
5. Median and slow-tail timings over repeated authenticated production trials.

Restore browser access and measure these paths before making further performance
claims or choosing another optimization. The Google transport benchmark and green
builds alone cannot establish the complete visible opening time.
