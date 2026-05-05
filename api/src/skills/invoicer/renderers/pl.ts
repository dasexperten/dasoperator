// =============================================================================
// PL — Packing List. Portrait A4. EN / RU. No money, no signature beyond a
// short shipper-signature line. Shipper / consignee can be a company OR a
// manufacturer (dei_layer Factory→DEI PL leg).
// =============================================================================

import type { DocumentLanguage, LineItemRow } from '../types';
import {
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderParty, blank,
  buildDeliveryBankTable, buildMetaRow, buildPartyTable, buildProductTable,
  buildTitle, formatDate, p,
  type ProductCell,
} from './shared';
import { AlignmentType } from 'docx';

export interface RenderPlInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;
  shipper: RenderParty;
  consignee: RenderParty;
  ciReference: string | null;
  lineItems: LineItemRow[];
}

export async function renderPackingList(input: RenderPlInput): Promise<Uint8Array> {
  const isRu = input.language === 'RU';
  const language: 'EN' | 'RU' = isRu ? 'RU' : 'EN';

  const titleText = isRu ? 'УПАКОВОЧНЫЙ ЛИСТ' : 'PACKING LIST';

  const meta = [
    { label: '№ / No.', value: input.reference },
    { label: 'Date / Дата', value: formatDate(input.issuedAt) },
  ];
  if (input.ciReference) {
    meta.push({ label: 'Related CI / Связанный СФ', value: input.ciReference });
  }

  const partyTable = buildPartyTable({
    language,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    shipperLabel: isRu ? 'ОТПРАВИТЕЛЬ' : 'SHIPPER',
    shipper: input.shipper,
    consigneeLabel: isRu ? 'ПОЛУЧАТЕЛЬ' : 'CONSIGNEE',
    consignee: input.consignee,
  });

  // Compute totals once — used for the right-side summary block AND
  // the TOTAL row of the product table.
  let totalCartons = 0;
  let totalQty = 0;
  let totalNet = 0;
  let totalGross = 0;
  let allWeightsKnown = true;

  const rows: ProductCell[][] = input.lineItems.map((li, idx) => {
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

    return [
      { text: String(idx + 1), align: 'center' },
      { text: li.product_id, align: 'left' },
      { text: desc, align: 'left' },
      { text: String(qtyPerCtn || ''), align: 'right' },
      { text: String(li.qty), align: 'right' },
      { text: String(cartons), align: 'right' },
      { text: lineNetKg !== null ? lineNetKg.toFixed(3) : 'TBD', align: 'right' },
      { text: lineGrossKg !== null ? lineGrossKg.toFixed(3) : 'TBD', align: 'right' },
    ];
  });

  // Summary block on the right (no bank on a stand-alone PL).
  const summaryLines: string[] = [
    `${isRu ? 'Мест' : 'Cartons'}: ${totalCartons}`,
    `${isRu ? 'Штук' : 'Total qty'}: ${totalQty}`,
  ];
  if (allWeightsKnown) {
    summaryLines.push(`${isRu ? 'Нетто, кг' : 'Net (kg)'}: ${totalNet.toFixed(3)}`);
    summaryLines.push(`${isRu ? 'Брутто, кг' : 'Gross (kg)'}: ${totalGross.toFixed(3)}`);
  } else {
    summaryLines.push(`${isRu ? 'Веса' : 'Weights'}: TBD`);
  }

  const summaryTable = buildDeliveryBankTable({
    language,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    deliveryHeader: isRu ? 'ОТГРУЗКА' : 'SHIPMENT',
    deliveryLines: [`${isRu ? 'К инвойсу' : 'For invoice'}: ${input.ciReference ?? '—'}`],
    rightHeader: isRu ? 'ИТОГИ' : 'SUMMARY',
    rightLines: summaryLines,
  });

  const widths = [350, 800, 3500, 900, 900, 800, 1000, 2250];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'SKU', align: 'left' as const },
    { text: isRu ? 'Описание' : 'Description', align: 'left' as const },
    { text: isRu ? 'Шт./кор.' : 'Qty/CTN', align: 'right' as const },
    { text: isRu ? 'Кол-во' : 'Total Qty', align: 'right' as const },
    { text: isRu ? 'Кор-ов' : 'Cartons', align: 'right' as const },
    { text: isRu ? 'Нетто, кг' : 'Net (kg)', align: 'right' as const },
    { text: isRu ? 'Брутто, кг' : 'Gross (kg)', align: 'right' as const },
  ];

  const productTable = buildProductTable({
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    widths,
    headers,
    rows,
    totalLabel: isRu ? 'ИТОГО' : 'TOTAL',
    totalLabelSpan: 4,
    totalValues: [
      { text: String(totalQty), align: 'right' },
      { text: String(totalCartons), align: 'right' },
      { text: allWeightsKnown ? totalNet.toFixed(3) : 'TBD', align: 'right' },
      { text: allWeightsKnown ? totalGross.toFixed(3) : 'TBD', align: 'right' },
    ],
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `Packing List ${input.reference}`,
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        buildTitle(titleText),
        buildMetaRow(meta),
        partyTable,
        blank(),
        summaryTable,
        blank(),
        productTable,
        blank(),
        p(isRu ? 'Подпись отправителя' : 'Shipper signature',
          { bold: true, size: 18, align: AlignmentType.RIGHT, spaceBefore: 200 }),
        p('_______________________', { align: AlignmentType.RIGHT, size: 16 }),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
