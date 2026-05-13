// =============================================================================
// IS-V2 — Toothpastes (Honghui format). Landscape A4. Trilingual EN+RU+CN.
// Two-party block (Shipper=Seller, Consignee=Buyer). Mandatory safety
// declarations footer (verbatim from invoicer skill). Used for toothpastes
// leaving China to Russia (HS 3306xxx).
// =============================================================================

import type { ContractRow, LineItemRow } from '../types';
import {
  Document, LANDSCAPE_PAGE, LANDSCAPE_USABLE_DXA, Packer, RenderBank,
  RenderParty, RenderSignature, blank, buildDeliveryBankTable, buildMetaRow,
  buildPartyTable, buildProductTable, buildSignature, buildBrandBar, buildTitle, formatDate,
  formatMoney, p, pickLineLabel, trilingual,
  type ProductCell,
} from './shared';

export interface RenderIsV2Input {
  reference: string;
  issuedAt: number;
  currency: string;
  shipperSeller: RenderParty;
  consigneeBuyer: RenderParty;
  bank: RenderBank | null;
  signature: RenderSignature;
  contract: ContractRow | null;
  incoterms: string;
  container: string | null;
  countryStation: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
}

const SAFETY_RU =
  'Не содержит средств криптографии и шифрования. ' +
  'Не содержит озоноразрушающие вещества. ' +
  'Товары не являются опасными отходами, не применяются в военных целях ' +
  'и не контактируют с пищевыми продуктами/водой.';

const SAFETY_CN =
  '该货物不是危险废物，不用于军事目的，也不与食物/水接触；' +
  '不包含密码和加密工具；不包含消耗臭氧层的物质。';

export async function renderInvoiceSpecPastes(input: RenderIsV2Input): Promise<Uint8Array> {
  const titleText = trilingual(
    'INVOICE — SPECIFICATION',
    'ИНВОЙС — СПЕЦИФИКАЦИЯ',
    '发票 — 规格',
  );

  const meta = [
    { label: trilingual('No.', '№', '发票号'), value: input.reference },
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
    shipperLabel: trilingual('SHIPPER / SELLER', 'ОТПРАВИТЕЛЬ / ПРОДАВЕЦ', '发货人 / 卖方'),
    shipper: input.shipperSeller,
    consigneeLabel: trilingual('CONSIGNEE / BUYER', 'ПОЛУЧАТЕЛЬ / ПОКУПАТЕЛЬ', '收货人 / 买方'),
    consignee: input.consigneeBuyer,
  });

  const deliveryLines: string[] = [input.incoterms || 'CNF Guangzhou'];
  if (input.container) {
    deliveryLines.push(`${trilingual('Container', 'Контейнер', '集装箱')}: ${input.container}`);
  }
  if (input.countryStation) {
    deliveryLines.push(`${trilingual('Country / Station', 'Страна / Станция', '国家 / 车站')}: ${input.countryStation}`);
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

  // Product table — 11 cols, sum 15400 DXA.
  // [#, HS Code, Origin, Description, Type, Qty, Cartons, Net, Gross, Price, Amount]
  const widths = [400, 1200, 1100, 4900, 1100, 950, 950, 1100, 1100, 1000, 1600];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'HS Code', align: 'center' as const },
    { text: trilingual('Origin', 'Страна', '原产地'), align: 'center' as const },
    { text: trilingual('Description', 'Описание', '产品描述'), align: 'left' as const },
    { text: trilingual('Type', 'Тип', '包装类型'), align: 'center' as const },
    { text: trilingual('Qty', 'Кол-во', '数量'), align: 'right' as const },
    { text: trilingual('Cartons', 'Кор.', '箱数'), align: 'right' as const },
    { text: trilingual('Net (kg)', 'Нетто', '净重'), align: 'right' as const },
    { text: trilingual('Gross (kg)', 'Брутто', '毛重'), align: 'right' as const },
    { text: trilingual('Price', 'Цена', '单价'), align: 'right' as const },
    { text: trilingual('Amount', 'Сумма', '总额'), align: 'right' as const },
  ];

  let totalQty = 0;
  let totalCartons = 0;
  let totalNet = 0;
  let totalGross = 0;
  let allWeightsKnown = true;

  const rows: ProductCell[][] = input.lineItems.map((li, idx) => {
    const desc = pickLineLabel(li, { kind: 'IS', variant: 'V2' });
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
      { text: li.hs_code ?? 'TBD', align: 'center' },
      { text: trilingual(li.country_of_origin ?? 'China', 'Китай', '中国'), align: 'center' },
      { text: desc, align: 'left' },
      { text: 'CARTON', align: 'center' },
      { text: String(li.qty), align: 'right' },
      { text: String(cartons), align: 'right' },
      { text: lineNetKg !== null ? lineNetKg.toFixed(3) : 'TBD', align: 'right' },
      { text: lineGrossKg !== null ? lineGrossKg.toFixed(3) : 'TBD', align: 'right' },
      { text: formatMoney(li.unit_price_after_disc, input.currency), align: 'right' },
      { text: formatMoney(li.line_amount, input.currency), align: 'right' },
    ];
  });

  // TOTAL row: label spans the first 5 cells (#, HS, Origin, Description, Type).
  // Remaining 6 cells: Qty, Cartons, Net, Gross, blank Price, Amount.
  const productTable = buildProductTable({
    totalWidthDxa: LANDSCAPE_USABLE_DXA,
    widths,
    headers,
    rows,
    totalLabel: trilingual('TOTAL', 'ИТОГО', '总计'),
    totalLabelSpan: 5,
    totalValues: [
      { text: String(totalQty), align: 'right' },
      { text: String(totalCartons), align: 'right' },
      { text: allWeightsKnown ? totalNet.toFixed(3) : 'TBD', align: 'right' },
      { text: allWeightsKnown ? totalGross.toFixed(3) : 'TBD', align: 'right' },
      { text: '', align: 'right' },
      { text: formatMoney(input.totalMinor, input.currency), align: 'right' },
    ],
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `IS-V2 ${input.reference}`,
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
        blank(),
        p(trilingual('Safety declarations', 'Декларации о безопасности', '安全声明'),
          { bold: true, size: 16 }),
        p(SAFETY_RU, { size: 14 }),
        p(SAFETY_CN, { size: 14 }),
        ...buildSignature(input.signature, 'BILINGUAL'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
