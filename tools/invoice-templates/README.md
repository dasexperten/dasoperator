# Invoice Template Standard (LOCKED 2026-05-28)

Single canonical PDF form for Commercial Invoice / Packing List / Invoice Specification
across all suppliers. Approved by Aram — do not alter layout without explicit sign-off.

## Form layout (every document, every supplier)
1. Header: SELLER block (EN + CN name) left, COMMERCIAL INVOICE title right, 2px rule under
2. FROM / BUYER two-column block
3. Meta band (grey): Invoice No | Date | Contract | Currency — bilingual EN/CN labels
4. Line items table: SKU | Description (EN + CN) | QTY | CTNS | UNIT | AMOUNT
   - black header bar, alternating padding, totals row with grey background
5. Amount in Words band (grey)
6. TERMS (left) + AUTHORIZED SIGNATORY block (right)

## HARD RULES
- **Single page**: autofit engine tries 5 compression levels (level0 roomy -> level4 tight),
  picks first that fits on one page. Never spills to page 2 without exhausting all levels.
- **Aspect ratio**: stamp/signature images NEVER distorted. Each fits within a per-seller
  `stamp_box` by constraining one dimension; the other is derived from the source aspect ratio.
- **Numbers bold**: all numeric values render font-weight 700.

## Per-seller assets (assets/)
| Seller | Stamp | Signatory | Notes |
|--------|-------|-----------|-------|
| jinxia | jinxia_stamp.png (circular, 1.02:1) | Lois Guan, Sales Manager | separate signature image |
| honghui | honghui_stamp.png (oval, 1.42:1) | Ellen Wei, Commercial Director | separate signature (ellen_wei_signature.png) |
| wdaa | wdaa_stamp_with_signature.png (3.72:1) | Ellen Wei, Commercial Director | signature BAKED into stamp on Authorized Signature line; HK text chop, no circular seal |

## Buyer profiles (our companies)
- dee = DAS EXPERTEN EURASIA LLC (INN 9704117379, KPP 130001001, Saransk RU)
- dei = DAS EXPERTEN INTERNATIONAL LLC (TRN 104184998300001, Sharjah UAE)

## Currency
CNY (¥, shows 元), USD ($), EUR (€). Amount-in-words auto-generated via num2words.

## Run
```
CF_ACCOUNT_ID=... CF_D1_DATABASE_ID=... CF_API_TOKEN=... python build_invoices.py
```
Pulls operation + line items from D1, picks seller profile, renders to single-page PDF.

## Dependencies
reportlab, pypdf, num2words, Pillow, wqy-zenhei font (CJK), pdf2image (verification only)
