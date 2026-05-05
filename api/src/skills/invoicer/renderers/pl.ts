// =============================================================================
// PL renderer — Packing List (Step 4B from the invoicer skill).
// No money, no signature. Shipper / consignee can each be a company OR a
// manufacturer (e.g. dei_layer Factory→DEI leg).
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type { DocumentLanguage, LineItemRow } from '../types';
import {
  RenderParty, blank, buildTable, formatDate, heading, p, partyBlock, subheading,
} from './shared';

export interface RenderPlInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;
  shipper: RenderParty;
  consignee: RenderParty;
  ciReference: string | null;
  lineItems: LineItemRow[];
}

interface PackedLine {
  sku: string;
  description: string;
  qtyTotal: number;
  qtyPerCtn: number;
  cartons: number;
  netKg: string;
  grossKg: string;
}

export async function renderPackingList(input: RenderPlInput): Promise<Uint8Array> {
  const isRu = input.language === 'RU';
  const langLite: 'EN' | 'RU' = isRu ? 'RU' : 'EN';

  let totalCartons = 0;
  let totalQty = 0;
  let totalNet = 0;
  let totalGross = 0;
  let allWeightsKnown = true;

  const packed: PackedLine[] = input.lineItems.map((li) => {
    const desc = isRu
      ? (li.description_ru ?? li.description_en ?? li.invoice_label ?? li.product_id)
      : (li.description_en ?? li.description_ru ?? li.invoice_label ?? li.product_id);
    const qtyPerCtn = li.ctn_qty ?? 0;
    const cartons = li.cartons > 0
      ? li.cartons
      : (qtyPerCtn > 0 ? Math.ceil(li.qty / qtyPerCtn) : 0);
    const lineNetKg = li.unit_net_weight_g !== null
      ? (li.qty * li.unit_net_weight_g) / 1000 : null;
    const lineGrossKg = (li.ctn_weight_gross_kg !== null && cartons > 0)
      ? cartons * li.ctn_weight_gross_kg : null;

    if (lineNetKg !== null) totalNet += lineNetKg; else allWeightsKnown = false;
    if (lineGrossKg !== null) totalGross += lineGrossKg; else allWeightsKnown = false;
    totalCartons += cartons;
    totalQty += li.qty;

    return {
      sku: li.product_id,
      description: desc,
      qtyTotal: li.qty,
      qtyPerCtn,
      cartons,
      netKg: lineNetKg !== null ? lineNetKg.toFixed(3) : 'TBD',
      grossKg: lineGrossKg !== null ? lineGrossKg.toFixed(3) : 'TBD',
    };
  });

  const cols = [
    { header: '#', widthPct: 4 },
    { header: 'SKU', widthPct: 10 },
    { header: isRu ? 'Описание' : 'Description', widthPct: 32 },
    { header: isRu ? 'Кол-во' : 'Qty', widthPct: 8 },
    { header: isRu ? 'Шт./Кор.' : 'Qty/CTN', widthPct: 8 },
    { header: isRu ? 'Кор-ов' : 'Cartons', widthPct: 8 },
    { header: isRu ? 'Нетто, кг' : 'Net (kg)', widthPct: 15 },
    { header: isRu ? 'Брутто, кг' : 'Gross (kg)', widthPct: 15 },
  ];

  const rows = packed.map((line, idx) => [
    String(idx + 1), line.sku, line.description,
    String(line.qtyTotal), String(line.qtyPerCtn), String(line.cartons),
    line.netKg, line.grossKg,
  ]);
  rows.push([
    '', '', isRu ? 'ИТОГО' : 'TOTAL',
    String(totalQty), '', String(totalCartons),
    allWeightsKnown ? totalNet.toFixed(3) : 'TBD',
    allWeightsKnown ? totalGross.toFixed(3) : 'TBD',
  ]);

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `PACKING LIST ${input.reference}`,
    sections: [{
      properties: {},
      children: [
        heading(isRu ? 'УПАКОВОЧНЫЙ ЛИСТ' : 'PACKING LIST'),
        blank(),
        p(`${isRu ? 'Упаковочный лист №' : 'Packing list No.'}: ${input.reference}`, { bold: true }),
        p(`${isRu ? 'Дата' : 'Date'}: ${formatDate(input.issuedAt)}`),
        ...(input.ciReference
          ? [p(`${isRu ? 'К инвойсу' : 'For invoice'}: ${input.ciReference}`)] : []),
        blank(),
        ...partyBlock({ language: langLite, label: isRu ? 'ОТПРАВИТЕЛЬ' : 'SHIPPER', party: input.shipper }),
        blank(),
        ...partyBlock({ language: langLite, label: isRu ? 'ПОЛУЧАТЕЛЬ' : 'CONSIGNEE', party: input.consignee }),
        blank(),
        buildTable(cols, rows),
        blank(),
        p(`${isRu ? 'Всего мест' : 'Total cartons'}: ${totalCartons}`,
          { bold: true }, AlignmentType.RIGHT),
        p(`${isRu ? 'Всего штук' : 'Total qty'}: ${totalQty}`, {}, AlignmentType.RIGHT),
        ...(allWeightsKnown ? [
          p(`${isRu ? 'Нетто, кг' : 'Net (kg)'}: ${totalNet.toFixed(3)}`, {}, AlignmentType.RIGHT),
          p(`${isRu ? 'Брутто, кг' : 'Gross (kg)'}: ${totalGross.toFixed(3)}`, {}, AlignmentType.RIGHT),
        ] : [
          p(isRu
            ? 'Веса частично TBD — заполнить products.unit_net_weight_g / ctn_weight_gross_kg'
            : 'Weights partially TBD — populate products.unit_net_weight_g / ctn_weight_gross_kg',
            { italic: true }, AlignmentType.RIGHT),
        ]),
        blank(),
        subheading(isRu ? 'Подпись отправителя' : 'Shipper signature'),
        p('_______________________'),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
