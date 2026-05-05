// =============================================================================
// IS-V2 — Toothpastes (Honghui format).
// Trilingual EN+RU+CN. Two-party block (Shipper=Seller, Consignee=Buyer).
// Mandatory safety declarations footer (verbatim from invoicer skill).
// Used for toothpastes leaving China to Russia (HS 3306xxx).
// =============================================================================

import { AlignmentType, Document, Packer, PageOrientation } from 'docx';
import type { ContractRow, LineItemRow } from '../types';
import {
  RenderBank, RenderParty, RenderSignature, bankBlock, blank, buildTableDxa,
  formatDate, formatMoney, heading, p, partyBlock, signatureBlock, subheading,
  trilingual,
} from './shared';

// A4 landscape — same setup as IS-V1; trilingual headers need the extra width.
const PAGE_LANDSCAPE = {
  size: {
    orientation: PageOrientation.LANDSCAPE,
    width: 16838,
    height: 11906,
  },
  margin: { top: 720, right: 720, bottom: 720, left: 720 },
} as const;

export interface RenderIsV2Input {
  reference: string;
  issuedAt: number;
  currency: string;
  shipperSeller: RenderParty;       // Honghui (or whoever the legal seller is)
  consigneeBuyer: RenderParty;      // DEE / partner
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
  const titleLine = trilingual(
    'INVOICE - PACKING LIST - SPECIFICATION',
    'Счёт-фактура - Упаковочный лист - Спецификация',
    '发票 - 装箱单 - 规格',
  );

  // DXA widths balanced for A4 landscape with 720 DXA margins (15398 DXA usable).
  // Description is the widest column — trilingual product names dominate it.
  // Column order intentionally matches the existing layout (Type sits after
  // Description); only widths and units change.
  const cols = [
    { header: '#', widthDxa: 500 },
    { header: 'HS Code', widthDxa: 1300 },
    { header: trilingual('Origin', 'Страна', '原产地'), widthDxa: 1200 },
    { header: trilingual('Description', 'Описание', '产品描述'), widthDxa: 4500 },
    { header: trilingual('Type', 'Тип', '包装类型'), widthDxa: 1300 },
    { header: trilingual('Qty', 'Кол-во', '数量'), widthDxa: 1000 },
    { header: trilingual('Cartons', 'Кор.', '箱数'), widthDxa: 900 },
    { header: trilingual('Net (kg)', 'Нетто', '净重'), widthDxa: 1100 },
    { header: trilingual('Gross (kg)', 'Брутто', '毛重'), widthDxa: 1100 },
    { header: trilingual('Price', 'Цена', '单价'), widthDxa: 1100 },
    { header: trilingual('Amount', 'Сумма', '总额'), widthDxa: 1400 },
  ];

  const rows: string[][] = input.lineItems.map((li, idx) => {
    const desc = trilingual(
      li.description_en ?? li.invoice_label ?? li.product_id,
      li.description_ru,
      li.description_cn,
    );
    const qtyPerCtn = li.ctn_qty ?? 0;
    const cartons = li.cartons > 0
      ? li.cartons
      : (qtyPerCtn > 0 ? Math.ceil(li.qty / qtyPerCtn) : 0);
    const net = li.unit_net_weight_g !== null
      ? ((li.qty * li.unit_net_weight_g) / 1000).toFixed(3)
      : 'TBD';
    const gross = (li.ctn_weight_gross_kg !== null && cartons > 0)
      ? (cartons * li.ctn_weight_gross_kg).toFixed(3)
      : 'TBD';
    return [
      String(idx + 1),
      li.hs_code ?? 'TBD',
      trilingual(li.country_of_origin ?? 'China', 'Китай', '中国'),
      desc,
      'CARTON',
      String(li.qty),
      String(cartons),
      net,
      gross,
      formatMoney(li.unit_price_after_disc, input.currency),
      formatMoney(li.line_amount, input.currency),
    ];
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `IS-V2 ${input.reference}`,
    sections: [{
      properties: { page: PAGE_LANDSCAPE },
      children: [
        heading(titleLine),
        blank(),
        p(`${trilingual('Invoice No.', 'Инвойс №', '发票号')}: ${input.reference}`, { bold: true }),
        p(`${trilingual('Date', 'Дата', '日期')}: ${formatDate(input.issuedAt)}`),
        ...(input.contract
          ? [p(`${trilingual('Contract', 'Договор', '合同号')}: ${input.contract.contract_no}`)] : []),
        ...(input.contract?.unk_reference
          ? [p(`УНК: ${input.contract.unk_reference}`)] : []),
        blank(),
        ...partyBlock({
          language: 'BILINGUAL',
          label: trilingual('SHIPPER / SELLER', 'ОТПРАВИТЕЛЬ / ПРОДАВЕЦ', '发货人 / 卖方'),
          party: input.shipperSeller,
        }),
        blank(),
        ...partyBlock({
          language: 'BILINGUAL',
          label: trilingual('CONSIGNEE / BUYER', 'ПОЛУЧАТЕЛЬ / ПОКУПАТЕЛЬ', '收货人 / 买方'),
          party: input.consigneeBuyer,
        }),
        blank(),
        p(`${trilingual('Delivery', 'Условия поставки', '交货条件')}: ${input.incoterms}`, { bold: true }),
        ...(input.container
          ? [p(`${trilingual('Container', 'Контейнер', '集装箱')}: ${input.container}`)] : []),
        ...(input.countryStation
          ? [p(`${trilingual('Country / Station', 'Страна / Станция', '国家 / 车站')}: ${input.countryStation}`)] : []),
        ...(input.bank
          ? [blank(), ...bankBlock(input.bank, 'BILINGUAL', trilingual('Bank details', 'Банковские реквизиты', '银行信息'))]
          : []),
        blank(),
        buildTableDxa(cols, rows),
        blank(),
        p(`${trilingual('TOTAL', 'ИТОГО', '总计')}: ${formatMoney(input.totalMinor, input.currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),

        blank(),
        subheading(trilingual('Safety declarations', 'Декларации о безопасности', '安全声明')),
        p(SAFETY_RU, { size: 18 }),
        p(SAFETY_CN, { size: 18 }),

        blank(),
        ...signatureBlock(input.signature, 'BILINGUAL'),
        p('盖章', {}, AlignmentType.RIGHT),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
