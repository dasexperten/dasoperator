# UPD/TN Renderer Spec — Full Official Forms

**Status:** Open task for invoicer chat
**Owner:** parallel chat (`api/src/skills/invoicer/`)
**Reference document:** [`example-upd-95.pdf`](./example-upd-95.pdf) — real UPD #95 from 20 Nov 2024 (Dasex Group transaction)
**Created:** 2026-05-09
**Created by:** session that runs the rest of the project (cannot touch invoicer territory directly)

## Why this exists

Current `renderers/upd.ts` and `renderers/tn.ts` are explicitly marked as **STUB** in their headers:

```ts
// STUB: produces a basic DOCX with header data and product table.
// Full official 17-column form will replace this once user provides exact layout.
```

User has now provided the exact layout via a real signed UPD. Parallel chat owns this code — this spec captures everything needed to upgrade the renderer without further round-trips.

---

## UPD — Full layout based on Постановление 1137 (с изменениями 534)

The reference PDF shows **Status 2** (передаточный документ only — без счёт-фактуры). Both Status 1 (счёт-фактура + передаточный) and Status 2 (only передаточный) must be supported.

### Top header row

```
Универсальный                                       Приложение № 1 к постановлению
передаточный документ                                Правительства РФ от 26 декабря 2011 г. № 1137
                                                     (в редакции постановлений Правительства РФ
                                                     от 19 августа 2017 г. № 981)

Исправление №          от                            (1а)

Статус: [1 or 2]
```

`Status` is rendered in a small bordered box on the left side, right of the title.

### Header field block (numbered fields per official form)

Each field has a label, value, and a small numeric reference in parentheses on the right margin (form numbering — required for tax inspectors to match form to regulation).

| № | Field name (Russian) | Source field |
|---|---|---|
| (1) | Счёт-фактура № _____ от _____ | Status 1: real reference. Status 2: blank |
| (1а) | Исправление № _____ от _____ | always blank in our system (we don't issue corrections via UPD) |
| (2) | Продавец: | seller party legalNameLocal |
| (2а) | Адрес: | seller addressLocal |
| (2б) | ИНН/КПП продавца: | seller inn / kpp (e.g. `9704117379/130001001`) |
| (3) | Грузоотправитель и его адрес: | If same as seller — text "см. же" or "тот же". Otherwise full party block |
| (4) | Грузополучатель и его адрес: | consignee block (legal name + address); for foreign buyers — name + foreign address |
| (5) | К платёжно-расчётному документу № _____ от _____ | usually blank for B2B sales |
| (6) | Покупатель: | buyer legalNameLocal (or legalNameEn if foreign) |
| (6а) | Адрес: | buyer addressLocal/addressEn |
| (6б) | ИНН/КПП покупателя: | buyer.inn / buyer.kpp. Foreign buyers: just inn (no kpp) |
| (7) | Валюта: наименование, код | always pair `Российский рубль, 643` for RUB; for other currencies — official OKV codes (USD=840, EUR=978, CNY=156) |
| (8) | Идентификатор государственного контракта, договора (соглашения) (при наличии) | always blank for our system |

### Product table — 13 columns (NOT 17 as stub comment claimed)

Header row uses two-level grouping for column 4 (units) and column 12 (country).

```
┌────┬──────────────────┬──────────┬──────────────────┬───────────┬──────────┬──────────────┬──────────┬──────────┬──────────┬──────────────┬───────────────────┬──────────────────┐
│ №  │ Наименование     │ Код      │ Единица          │ Количество│ Цена     │ Стоимость    │ В т.ч.   │ Налоговая│ Сумма    │ Стоимость    │ Страна            │ Регистрационный  │
│ п/п│ товара (работ,   │ вида     │ измерения        │ (объём)   │ (тариф)  │ товаров      │ сумма    │ ставка   │ налога,  │ товаров      │ происхождения     │ номер            │
│    │ услуг),          │ товара   ├──────┬───────────┤           │ за       │ (работ,      │ акциза   │          │ предъяв- │ (работ,      │ товара            │ декларации /     │
│    │ имущественного   │          │ код  │ условное  │           │ единицу  │ услуг),      │          │          │ ляемая   │ услуг),      ├──────┬────────────┤ партии товара    │
│    │ права            │          │      │ обозначе- │           │ изме-    │ имущест-     │          │          │ покупа-  │ имущест-     │ цифр-│ краткое    │                  │
│    │                  │          │      │ ние (на-  │           │ рения    │ венных прав  │          │          │ телю     │ венных прав  │ овой │ наимено-   │                  │
│    │                  │          │      │ цион.)    │           │          │ без налога — │          │          │          │ с налогом    │ код  │ вание      │                  │
│    │                  │          │      │           │           │          │ всего        │          │          │          │ — всего      │      │            │                  │
├────┼──────────────────┼──────────┼──────┼───────────┼───────────┼──────────┼──────────────┼──────────┼──────────┼──────────┼──────────────┼──────┼────────────┼──────────────────┤
│ А  │       1          │   1а     │  2   │    2а     │     3     │    4     │      5       │    6     │    7     │    8     │      9       │  10  │   10а      │       11         │
└────┴──────────────────┴──────────┴──────┴───────────┴───────────┴──────────┴──────────────┴──────────┴──────────┴──────────┴──────────────┴──────┴────────────┴──────────────────┘
```

Column count: **13 visible columns** but **15 official numeric refs** (because columns 4 and 12 each split into two sub-columns).

| Visible col | Width hint | Header text | Source data | Sample value |
|---|---|---|---|---|
| А | small | № п/п | row index (1-based) | 1 |
| 1 | wide | Наименование товара (работ, услуг), имущественного права | `lineItem.invoice_label` ?? `item_description` ?? `product_id` | `Das Experten SCHWARZ toothbrush` |
| 1а | small | Код вида товара | `lineItem.tnved_code` (4-digit "Код вида товара" — currently absent in DB; render `—` if null) | `—` |
| 2 | small | Единица измерения — код | OKEI code: `шт=796`, `кг=166`, `л=112`, `упак=778`. From `lineItem.unit_okei_code` or default `796` | `796` |
| 2а | small | условное обозначение | `шт`, `кг`, `л`, `упак` | `шт` |
| 3 | small | Количество (объём) | `lineItem.qty` formatted with `.000` (always 3 decimals) | `12960.000` |
| 4 | medium | Цена (тариф) за единицу измерения | `lineItem.unit_price_after_disc` formatted ru-RU 2dp | `46.00` |
| 5 | medium | Стоимость товаров (работ, услуг), имущественных прав без налога — всего | `lineItem.line_amount` if VAT=0; else `lineItem.line_amount / (1 + vat/100)` | `596 160.00` |
| 6 | small | В том числе сумма акциза | always `без акциза` | `без акциза` |
| 7 | small | Налоговая ставка | `Без НДС` if vat=0; `0%`, `10%`, `20%` otherwise | `Без НДС` |
| 8 | small | Сумма налога, предъявляемая покупателю | computed VAT amount; `Без НДС` if vat=0 | `Без НДС` |
| 9 | medium | Стоимость товаров (работ, услуг), имущественных прав с налогом — всего | `lineItem.line_amount` | `596 160.00` |
| 10 | tiny | Страна происхождения товара — цифровой код | OKSM 3-digit code from `lineItem.country_of_origin` (China=`156`, Russia=`643`, Vietnam=`704`). | `156` |
| 10а | small | краткое наименование | OKSM short name (`КИТАЙ`, `РОССИЯ`, `ВЬЕТНАМ`) | `КИТАЙ` |
| 11 | medium | Регистрационный номер декларации на товары / партии товара | `lineItem.gtd_number` (declaration number, currently absent; render `—`) | `—` |

### After the table

After all rows, two summary lines (right-aligned):

```
Всего к оплате                                            X        1 815 862,65
```

Format: `Всего к оплате` label, then column 8 sum (just `X` if all лучше без НДС), then column 9 sum.

### Section: "Документ составлен на N листах"

Plain text, italic-ish, count of physical printed pages. For our system: render number of A4 sheets the table will occupy. **Pragmatic approach:** estimate as `Math.ceil(rows.length / 25)` — typical UPD packs ~25 line items per A4 landscape.

```
Документ составлен на 1 листе
```

### Section: "Основание передачи (сдачи) / получения (приёмки)"

Label cell + value:

```
Основание передачи (сдачи)/получения (приёмки)         Договор: № 101022 от 10.10.2022 (руб.)
                                                       (договор; доверенность и т.д.)
```

Source: `contract.contract_no`, `contract.signed_date`, `contract.currency`. Currency in parentheses lowercase Russian (`руб.`, `долл.`, etc.).

If contract is a placeholder (`/^NO[-\s]CONTRACT/i.test(contract.contract_no)`) — render this section blank or "—".

### Section: "Данные о транспортировке и грузе"

Free-form text:

```
Данные о транспортировке и грузе                      масса брутто: одна тысяча сто тридцать
                                                      девять девятого десять граммов, объём:
                                                      3,8881511 м³
```

For our system, compute from line items:
- Total weight kg = `sum(lineItem.qty * unit_net_weight_g) / 1000`
- Total volume m³ = `sum(cartons * ctn_dim_l_cm * ctn_dim_w_cm * ctn_dim_h_cm) / 1_000_000`

Render as `масса брутто: {kg} кг, объём: {m³} м³` (omit Russian word-form for now, it's optional — the form just expects "в т.ч. вес/объём указан").

### Bottom section — signatures and acceptance

This is the part that distinguishes UPD from a regular invoice. It captures **two** signing parties — sender (left half) and receiver (right half).

```
LEFT HALF (sender):                                  RIGHT HALF (receiver):

(10) Товар (груз) передал/услуги, результаты         (15) Товар (груз) получил/услуги, результаты
работ, права сдал                                    работ, права принял

[signature]      Бадалян А.В.                       [signature]      ________________
(должность)        (подпись)        (ф.и.о.)         (должность)        (подпись)        (ф.и.о.)

(11) Дата отгрузки, передачи (сдачи)                 (16) Дата получения (приёмки)
   «20» ноября 2024 года                                «  »                  года

(12) Иные сведения об отгрузке, передаче              (17) Иные сведения о получении, приёмке
[blank]                                                [blank]

(13) Ответственный за правильность                   (18) Ответственный за правильность
оформления факта хозяйственной жизни                 оформления факта хозяйственной жизни
                                                      
[signature]      Бадалян А.В.                       [signature]      ________________
(должность)        (подпись)        (ф.и.о.)         (должность)        (подпись)        (ф.и.о.)

(14) Наименование экономического субъекта            (19) Наименование экономического субъекта
— составителя документа                              — составителя документа
                                                      (можеш быть указан И.о., М.П., может быть ...)

ООО ДАС ЭКСПЕРТЕН ЕВРАЗИЯ                            Dasex Group LLC, ИНН 02283059
ИНН/КПП 9704117379/130001001
```

Render this as a 2-column docx table with hairline borders. Each numbered subsection is its own row.

For our system data:
- (10), (15): use `RenderSignature.name` from seller/buyer side
- (11): `formatRussianDate(operation.shipment_date ?? operation.created_at)` → `«20» ноября 2024 года`
- (13), (18): same person as (10)/(15) — usually the GM
- (14): seller `legalNameLocal` + ИНН/КПП row
- (19): buyer `legalNameLocal` + ИНН (and КПП if Russian buyer)

If buyer is foreign (no Russian ИНН matching pattern): render their tax_id labelled per their jurisdiction or just blank cell.

### Page setup

- Orientation: **Landscape A4**
- Margins: narrow (10mm L/R, 12mm T/B) to fit all 13 columns
- Font: serif (Times New Roman or Arial) — body 9pt, header 8pt, title 14pt bold
- Locale: ru-RU for all formatting

---

## TN — Транспортная накладная (Постановление 2200 от 21.12.2020)

This document was NOT included in the user's reference PDF. **DEFER** until user provides a real ТН sample. Current `tn.ts` stub remains acceptable as fallback.

When user provides ТН reference:
- TN has **17 numbered sections** (Грузоотправитель, Грузополучатель, Груз, Сопроводительные документы, Указания, Перевозчик, Транспорт, Прием груза, Переадресовка, Сдача груза, Стоимость, Информация о принятии заказа, Прочие условия, Отметки, Стоимость услуг перевозчика, Подписи)
- Section 1 = full sender block (organization + ИНН/КПП + address + phone + driver/handler contact)
- Section 4 = list of accompanying documents (УПД №X — link to the related UPD reference)
- Section 6 = carrier (3PL company); if no 3PL → "Самовывоз"
- Section 8 = receiving acknowledgement (matches UPD section 15)

Until then keep current stub but add a comment: "STUB — replace per docs/specs/upd-tn-reference/ when TN sample provided".

---

## Code locations to modify

```
api/src/skills/invoicer/renderers/upd.ts    ← rewrite to full form
api/src/skills/invoicer/renderers/shared.ts ← may need helpers:
  - russianDateLong(unixSec)  → "«20» ноября 2024 года"
  - oksmShortName(code)       → "КИТАЙ" / "РОССИЯ" / "ВЬЕТНАМ" / "—"
  - oksmCode(country_of_origin) → "156" / "643" / "704" / "—"
  - okeiUnit(category) → { code: "796", short: "шт" }  (default 796/шт)
api/src/skills/invoicer/types.ts             ← LineItemRow may need:
  - tnved_code?: string | null    (4-digit code; nullable)
  - gtd_number?: string | null    (customs declaration number; nullable)
  - unit_okei_code?: string | null (default '796')
api/src/skills/invoicer/data-loader.ts       ← join those fields when loading
```

DB migration if those fields don't exist yet (ask before adding):

```sql
ALTER TABLE products ADD COLUMN tnved_code TEXT;     -- 4-digit ТН ВЭД
ALTER TABLE products ADD COLUMN okei_code TEXT;      -- default '796' for шт
ALTER TABLE line_items ADD COLUMN gtd_number TEXT;   -- customs declaration #
```

---

## Testing approach

1. Generate UPD for an existing operation (e.g. `alfa_inv_809_2026_04` — alfa_klass DEE-001).
2. Open in MS Word side-by-side with `example-upd-95.pdf`.
3. Visually compare: header field labels match, numbering match, table structure match, signature blocks match.
4. Print to PDF, check landscape A4 fits without horizontal cropping.

---

## Out of scope for this spec

- ТН full form (no reference yet — see TN section above)
- ЭДО integration (electronic UPD via Diadoc/Kontur — separate phase)
- Digital signature embedding (separate phase)
- Multi-page UPD numbering (handle later when first 25-row case appears)
