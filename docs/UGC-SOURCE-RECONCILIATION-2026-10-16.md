# UGC source reconciliation, 16 October 2026

The Owner requested missing RUB amounts and product identities on `/ugc`.
The follow-up explicitly selected **the total of all register rows**, including
repeated rows, rather than separate amounts. A register total is not a settled
payment total. It is labelled `по реестру` and never enters the executable payout
queue, green paid badges, daily paid counters or `paid_total_minor`.

## Sources and boundaries

- Blogger products: native `ugc_blogger_database`, document
  `1lHOj0C7kCVkorFmMLckVbcFeHhF1fmSSGo0ByYHCQqg`, Sheet1, A1:N997.
- Additional products: native `new_blogger_database`, document
  `1JLZ0gojsm0yDGU_I98gHjLaAq5O_22eGypfOM4_GyvI`, Sheet1, A1:O1003.
- Historical amounts: `Оплаты Консоль`, document
  `17FQ-ZBHVNl_R94tFd27Al_irYCedU78H9GoWbi8uK0c`, Sheet1,
  B1:C3060 and H1:H3060. Checkbox C is preserved but never interpreted as bank
  execution. All 711 matched valid rows are retained, including zero and repeats.
- One malformed amount, source row 118, has an 11-digit telephone-like value
  rather than an established monetary amount. It is explicitly excluded.
- Four legacy product IDs were read directly from live ERP `products`:
  DE108 KINDER 3+, DE114 ZUNGER, DE118 DOLPHIN KINDER 1+, DE123 BIO.

Only exact normalized handles are matched. Product evidence is tied to the exact
platform. Historical payment records prefer an exact Instagram match, otherwise
a single unambiguous profile; 14 ambiguous rows remain out. Another 575 payment
rows have no matching current ERP account. No new creators are invented for them.

Names alone do not establish subtype. Bare SCHWARZ and INNOWEISS are displayed
as product family names without assigning paste, brush, floss or mouthwash SKUs.
LAST_PRODUCT is creator history; it is never copied onto unrelated publications.
The original content classifications, payout states and all bank details stay
intact. Private source extracts and snapshots are outside GitHub.

## Expected coverage from the live pre-write snapshot

- 1,296 source records: 585 product references and 711 amount rows.
- 282 accounts have historical register rows, totalling **348,555 RUB**.
- 256 formerly blank payment cells receive a register total. Current payout
  records retain precedence; their historical rows are visible in the card.
- 498 profiles have product evidence from the two source databases.
- Product coverage grows from 208 to 501 profiles, adding 293 profiles.
- Source evidence includes 389 profiles with specific catalogued SKUs; ambiguous
  product family names remain explicitly untyped.

The numbers above are source-record and profile coverage, not verified transfers,
new publications or a measurement of campaign performance.

## Implementation and validation

Migration `0127_ugc_source_records.sql` separates source facts from live money.
`tools/plan-ugc-source-backfill.mjs` builds deterministic import records from
minimized source extracts and the live profile snapshot. Stable source-row keys
make the import idempotent. API and desktop/mobile payment cells expose totals;
the creator card links to every contributing source row.

Validation before release: 51 relevant Node tests passed, including payout
execution/idempotency and name ambiguity; Web TypeScript passed; the Worker
bundled successfully with Wrangler dry-run; migration numbers and diff checks
passed. The full API TypeScript check has pre-existing errors outside UGC;
there are no diagnostics in the changed UGC API modules.

Release requires migration/data application from pushed main, successful API and
Pages production deployments, and a live page readback. No bank transfer,
creator message or payment-state update is part of this reconciliation.

## Production readback

Migration and all 1,296 source records were applied from clean pushed commit
`25beb25d2a7e6cca9fe7a0fe3a90a6ef7ed64fee`. D1 readback confirmed 711 amount
rows, 282 linked accounts, 34,855,500 minor RUB units, 585 product references,
498 linked profiles and no orphaned creator links.

Both production workflows completed successfully: Worker run `38888332375` and
Pages run `38888332379`. The GitHub Contents API confirmed the source-file blobs.

Browser readback inspected all 747 then-visible table rows: 501 had product
identification and 255 displayed the historical register total. One of the
originally projected 256 blanks acquired a current payout during this work;
current payout precedence therefore explains the difference. Other attended
sessions continued creating/paying creators during this reconciliation.

Examples verified in the live table: `lnv1979` 2,665 RUB,
`marina.stikanova_21` 1,866 RUB, `viktoriya_guleeva_39` 1,572 RUB and
`a_fadeeva_99` 1,396 RUB. The last row also showed DE201, DE206 and DE130.
All historical values were grey and labelled `по реестру`.

Remaining unknown products have no sufficient product evidence in these two
source databases. Some rows are `other` records with the same handle but no
stored profile URL; no cross-platform identity or merge is inferred for them.
