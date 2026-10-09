// =============================================================================
// IS-V1 — Brushes (Yangzhou Jinxia format). Landscape A4. Bilingual EN+RU.
// Three-party block (Shipper / Consignee / optional Seller). Used for
// toothbrushes leaving China to Russia (HS 9603xxx).
// =============================================================================

import type { ContractRow, LineItemRow, PackingDetails } from '../types';
import { packedLine, packedTotals } from './packing';
import {
  Document, LANDSCAPE_PAGE, LANDSCAPE_USABLE_DXA, Packer, RenderBank,
  RenderParty, RenderSignature, bilingual, blank, buildDeliveryBankTable,
  buildMetaRow, buildPartyTable, buildProductTable, buildSignature, buildBrandBar, buildTitle,
  formatDate, formatMoney, pickLineLabel, trilingual,
  type ProductCell, DOC_STYLES,
} from './shared';

export interface RenderIsV1Input {
  reference: string;
  issuedAt: number;
  currency: string;
  shipper: RenderParty;
  buyer: RenderParty;
  seller: RenderParty;
  sellerDistinctFromShipper: boolean;
  bank: RenderBank | null;
  signature: RenderSignature;
  contract: ContractRow | null;
  incoterms: string;
  consigneeAtTerminal: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
  /** Factory packing figures from the operation; override product-card weights. */
  packingDetails?: PackingDetails | undefined;
}

export async function renderInvoiceSpecBrushes(input: RenderIsV1Input): Promise<Uint8Array> {
  const titleText = trilingual(
    'INVOICE-SPECIFICATION',
    'СЧЁТ-СПЕЦИФИКАЦИЯ',
    '发票-规格',
  );

  const meta = [
    { label: '№ / No.', value: input.reference },
    { label: trilingual('Date', 'Дата', '日期'), value: formatDate(input.issuedAt) },
  ];
  if (input.contract) {
    meta.push({ label: trilingual('Contract', 'Договор', '合同号'), value: input.contract.contract_no });
  }
  if (input.contract?.unk_reference) {
    meta.push({ label: 'УНК', value: input.contract.unk_reference });
  }

  const partyTable = buildPartyTable({
    language: 'BILINGUAL',
    totalWidthDxa: LANDSCAPE_USABLE_DXA,
    shipperLabel: trilingual('SHIPPER', 'ОТПРАВИТЕЛЬ', '发货人'),
    shipper: input.shipper,
    consigneeLabel: trilingual('CONSIGNEE / BUYER', 'ПОЛУЧАТЕЛЬ / ПОКУПАТЕЛЬ', '收货人'),
    consignee: input.buyer,
    sellerLabel: trilingual('SELLER', 'ПРОДАВЕЦ', '卖方'),
    seller: input.seller,
    sellerDistinct: input.sellerDistinctFromShipper,
  });

  const deliveryLines = [input.incoterms || 'FOB Shanghai'];
  if (input.consigneeAtTerminal) {
    deliveryLines.push(`${trilingual('Consignee at terminal', 'Получатель по ст.', '终点站收货人')}: ${input.consigneeAtTerminal}`);
  }

  const deliveryBankTable = buildDeliveryBankTable({
    language: 'BILINGUAL',
    totalWidthDxa: LANDSCAPE_USABLE_DXA,
    deliveryHeader: trilingual('DELIVERY', 'УСЛОВИЯ ПОСТАВКИ', '交货条件'),
    deliveryLines,
    bank: input.bank,
    ...(input.bank
      ? { bankHeader: trilingual('BANK DETAILS', 'БАНКОВСКИЕ РЕКВИЗИТЫ', '银行信息') }
      : {}),
  });

  // Product table — 10 cols, sum 15400 DXA. Description is the widest so each line stays on one row.
  // [#, HS Code, Origin, Description, Qty pcs, Cartons, Net kg, Gross kg, Price, Amount]
  const widths = [400, 1100, 1100, 6000, 900, 1000, 1000, 1000, 1200, 1700];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'HS Code', align: 'center' as const },
    { text: bilingual('Origin', 'Страна'), align: 'center' as const },
    { text: bilingual('Description', 'Описание'), align: 'left' as const },
    { text: bilingual('Qty (pcs)', 'Кол-во'), align: 'right' as const },
    { text: bilingual('Cartons', 'Кор\u2011ов'), align: 'right' as const },
    { text: bilingual('Net (kg)', 'Нетто'), align: 'right' as const },
    { text: bilingual('Gross (kg)', 'Брутто'), align: 'right' as const },
    { text: bilingual('Price', 'Цена'), align: 'right' as const },
    { text: bilingual('Amount', 'Сумма'), align: 'right' as const },
  ];

  let totalQty = 0;
  let totalCartons = 0;
  const packed = input.lineItems.map((li) => packedLine(li, input.packingDetails));
  const packedTotal = packedTotals(packed, input.packingDetails);

  const rows: ProductCell[][] = input.lineItems.map((li, idx) => {
    const desc = pickLineLabel(li, { kind: 'IS', variant: 'V1' });
    const { cartons, netKg: lineNetKg, grossKg: lineGrossKg } = packed[idx]!;
    totalCartons += cartons;
    totalQty += li.qty;

    return [
      { text: String(idx + 1), align: 'center' },
      { text: li.hs_code ?? 'TBD', align: 'center' },
      { text: bilingual(li.country_of_origin ?? 'China', 'Китай'), align: 'center' },
      { text: desc, align: 'left' },
      { text: String(li.qty), align: 'right' },
      { text: String(cartons), align: 'right' },
      { text: lineNetKg !== null ? lineNetKg.toFixed(3) : 'TBD', align: 'right' },
      { text: lineGrossKg !== null ? lineGrossKg.toFixed(3) : 'TBD', align: 'right' },
      { text: formatMoney(li.unit_price_after_disc, input.currency), align: 'right' },
      { text: formatMoney(li.line_amount, input.currency), align: 'right' },
    ];
  });

  // TOTAL row: merge the first 4 cells (label spans #..Description) and
  // print Qty / Cartons / Net / Gross / Price / Amount (6 values).
  const productTable = buildProductTable({
    totalWidthDxa: LANDSCAPE_USABLE_DXA,
    widths,
    headers,
    rows,
    totalLabel: bilingual('TOTAL', 'ИТОГО'),
    totalLabelSpan: 4,
    totalValues: [
      { text: String(totalQty), align: 'right' },
      { text: String(totalCartons), align: 'right' },
      { text: packedTotal.netKg !== null ? packedTotal.netKg.toFixed(3) : 'TBD', align: 'right' },
      { text: packedTotal.grossKg !== null ? packedTotal.grossKg.toFixed(3) : 'TBD', align: 'right' },
      { text: '', align: 'right' },
      { text: formatMoney(input.totalMinor, input.currency), align: 'right' },
    ],
  });

  const doc = new Document({
    styles: DOC_STYLES,
    creator: 'dasoperator-api',
    title: `IS-V1 ${input.reference}`,
    sections: [{
      properties: { page: LANDSCAPE_PAGE },
      children: [
        buildTitle(titleText),
        buildBrandBar(),
        buildMetaRow(meta),
        partyTable,
        blank(),
        deliveryBankTable,
        blank(),
        productTable,
        ...buildSignature(input.signature, 'BILINGUAL'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
