# Full original UGC workbook audit, 16 October 2026

The Owner rejected the first pass as incomplete and requested every row to be
scanned. The first pass used two similarly named product tables and the Konsol
register. It missed the actual workbook imported into ERP: **Blooger Database**,
native Google Sheet `1U8tY23CA6kUfrybqmtkC_irUgDFSdJ326JyhnZ7FsIM`.

## Exhaustive source read

- `Sheet1!A1:AI1262`: all 1,262 rows and 35 columns.
- `NEW!A1:V1001`: the full sheet grid, with 317 populated rows and empty trailing
  rows. No populated columns exist beyond T on Sheet1 or H on NEW.
- Sheet1 A is a grouped handle column: blanks continue the preceding creator.
  A1 itself names the first creator while B1:U1 contain headers.
- All 578 populated Sheet1 E (`sum`) cells were parsed and retained. Formats
  include `4,472.00 ₽` and the explicit addition `472+6`; the latter is 478 RUB
  as recorded, with the raw expression preserved. Column D payment requisites
  are not imported or published.
- Products were read from all five explicit columns N:R and text column S
  (`pivot name`), plus NEW D:E. This adds evidence for 504 profiles. NEW row 4
  contains the invalid product code `3`; it remains an explicit unresolved
  source error, never a fabricated SKU.

## Four verified identity repairs

| Source row | Error in A | Verified account | Evidence |
|---|---|---|---|
| Sheet1:67 | two reel URLs | ekaterina_ria | Live second reel [C7wtY7zoSih](https://www.instagram.com/reel/C7wtY7zoSih/) and the creator's own archived shared link, thread-4600 |
| Sheet1:435 | `pozdnyakovaylia ..` | pozdnyakovaylia | Original A435 rich-text hyperlink to the exact account, corroborated by the creator's own shared reel C-0vUqWxvoq in thread-0926 |
| Sheet1:475 | a reel URL | mamavlada19.07 | Live [C-zBE2oN5aX](https://www.instagram.com/reel/C-zBE2oN5aX/), whose author and caption name BIO, MITTEL and GINGER FORCE |
| Sheet1:488 | `COCOCANNABIS, MITTEL` | galievagelnaziia | Live [DAB2tPftz5s](https://www.instagram.com/p/DAB2tPftz5s/) identifies the author and MITTEL |

The old `reel` placeholder combined rows 67 and 475 from two different people.
Migration 0129 retains the existing id for ekaterina_ria, creates one canonical
profile for mamavlada19.07, and moves only row 475 to its verified author. The
other two broken handles are corrected in place. No unrelated account is merged.

## Coverage and source precedence

The full workbook contributes **578 amount rows for 494 accounts**, with a
recorded total of **305,403 RUB**. Combined account coverage with the previous
register is **654 accounts**. Product evidence covers **504 profiles**.

The two monetary sources may describe the same payments. Their totals are
therefore NEVER added to each other. The Owner's instruction to sum every row,
including repeats, applies **within each source**:

1. Prefer the original Blooger Database E cells for the main historical amount.
2. When absent, use the earlier Konsol register H cells.
3. Keep both source-specific totals and every contributing row accessible in the
   creator card. Links point to the correct E or H source cell.
4. Current payout badges retain precedence over historical totals. None of this
   proves bank execution, creates a payable, triggers a creator message, or
   changes daily paid counters.

Missing source products remain missing. Bare INNOWEISS or SCHWARZ retain their
family names without an unsupported subtype. Product history is not copied to
every publication. Private minimized extracts, workbook snapshots and audit
inputs remain outside GitHub.

## Reproducibility and verification

`tools/plan-ugc-workbook-backfill.mjs` builds deterministic source-row records and
an exception list. Verified account overrides are explicit, evidenced inputs.
The input is the minimized full source extract and a live profile snapshot.
Stable source-row keys make reapplication idempotent.

Before release, 56 relevant Node tests passed. They cover grouped rows, the
first header handle, money formats/additions, correct NEW column interpretation,
source precedence, cross-source non-duplication, product ambiguity and the
existing payout execution safeguards. Web TypeScript and migration numbering
checks passed. Production import and browser readback are recorded after release.

## Production readback

Release `1b754785d80f7f8098286033d6ffa9345512ee02` is on GitHub main;
Worker deployment [38894736142](https://github.com/dasexperten/dasoperator/actions/runs/38894736142)
and Pages deployment [38894736167](https://github.com/dasexperten/dasoperator/actions/runs/38894736167)
both succeeded. The identity migration and all 1,169 source records were applied
from the clean pushed tree. Each imported field was read back and compared
against the plan: 1,169 exact matches, zero orphan profile references.

Live database readback confirms 578 original payment rows / 494 accounts /
305,403 RUB, 591 original product references / 504 profiles, and 654 unique
accounts with monetary history across the two separate sources. All four
repaired source observations resolve to their verified authors.

Browser readback on the live ERP showed 749 creator rows, 504 with product
evidence, and 623 historical payment cells; current payouts take precedence
on the remaining covered accounts. The updated creator panel was verified
with `a_fadeeva_99`: original workbook total 934 RUB (E376: 478 RUB; E431:
456 RUB), separate Konsol register total 1,396 RUB, products DE201, DE206
and DE130. The E-cell links and the separate-source notice are visible and
correct. Historical source imports did not write payout rows or execute money.

A follow-up copy correction replaces the old LAST_PRODUCT-only description
with a source-neutral description, reflecting the original product columns
and pivot text now used.
