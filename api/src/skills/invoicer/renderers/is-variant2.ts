// =============================================================================
// IS Variant 2 — Toothpastes / Honghui format. Step 4C V2 from the skill.
// Trilingual RU+EN+CN, two-party block (Shipper=Honghui, Consignee=DEE),
// mandatory safety declarations footer. Used for toothpastes (HS 3306xxx)
// leaving China to Russia.
//
// Safety declaration text is taken verbatim from the invoicer skill —
// changing it requires updating the skill, not this file.
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type {
  CompanyRow, ContractRow, LineItemRow, ManufacturerBankRouteRow,
  ManufacturerRow,
} from '../types';
import {
  blank, buildTable, formatDate, formatMoney, heading, p, subheading,
} from './shared';

export interface RenderIsV2Input {
  reference: string;
  issuedAt: number;
  currency: string;
  manufacturer: ManufacturerRow;
  buyerCompany: CompanyRow;          // typically DEE
  contract: ContractRow | null;
  bankRoute: ManufacturerBankRouteRow | null;
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

function trilingual(en: string, ru: string, cn: string): string {
  return [en, ru, cn].filter(Boolean).join(' / ');
}

export async function renderInvoiceSpecPastes(input: RenderIsV2Input): Promise<Uint8Array> {
  const m = input.manufacturer;
  const dee = input.buyerCompany;

  const titleLine = trilingual(
    'INVOICE - PACKING LIST - SPECIFICATION',
    'Счёт-фактура - Упаковочный лист - Спецификация',
    '发票 - 装箱单 - 规格',
  );

  const cols = [
    { header: '#', widthPct: 4 },
    { header: 'HS Code', widthPct: 11 },
    { header: trilingual('Origin', 'Страна', '原产地'), widthPct: 9 },
    { header: trilingual('Description', 'Описание', '产品描述'), widthPct: 26 },
    { header: trilingual('Type', 'Тип', '包装类型'), widthPct: 6 },
    { header: trilingual('Qty', 'Кол-во', '数量'), widthPct: 7 },
    { header: trilingual('Cartons', 'Кор.', '箱数'), widthPct: 7 },
    { header: trilingual('Net (kg)', 'Нетто', '净重'), widthPct: 8 },
    { header: trilingual('Gross (kg)', 'Брутто', '毛重'), widthPct: 8 },
    { header: trilingual('Price', 'Цена', '单价'), widthPct: 7 },
    { header: trilingual('Amount', 'Сумма', '总额'), widthPct: 7 },
  ];

  const rows: string[][] = input.lineItems.map((li, idx) => {
    const desc = trilingual(
      li.description_en ?? li.invoice_label ?? li.product_id,
      li.description_ru ?? '',
      li.description_cn ?? '',
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
      'Carton', // type of package — stable for our SKUs
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
      properties: {},
      children: [
        heading(titleLine),
        blank(),
        p(`${trilingual('Invoice No.', 'Инвойс №', '发票号')}: ${input.reference}`, { bold: true }),
        p(`${trilingual('Date', 'Дата', '日期')}: ${formatDate(input.issuedAt, 'BILINGUAL')}`),
        ...(input.contract
          ? [p(`${trilingual('Contract', 'Договор', '合同号')}: ${input.contract.contract_no}`)]
          : []),

        blank(),
        subheading(trilingual('SHIPPER / SELLER', 'ОТПРАВИТЕЛЬ / ПРОДАВЕЦ', '发货人 / 卖方')),
        ...(m.legal_name_en ? [p(m.legal_name_en, { bold: true, size: 18 })] : []),
        ...(m.legal_name_ru ? [p(m.legal_name_ru, { size: 18 })] : []),
        ...(m.legal_name_cn ? [p(m.legal_name_cn, { size: 18 })] : []),
        ...(m.registered_address_en ? [p(m.registered_address_en, { size: 18 })] : []),
        ...(m.registered_address_ru ? [p(m.registered_address_ru, { size: 18 })] : []),
        ...(m.tax_id ? [p(`USCC: ${m.tax_id}`, { size: 18 })] : []),

        blank(),
        subheading(trilingual('CONSIGNEE / BUYER', 'ПОЛУЧАТЕЛЬ / ПОКУПАТЕЛЬ', '收货人 / 买方')),
        p(dee.legal_name, { bold: true, size: 18 }),
        ...(dee.legal_name_ru ? [p(dee.legal_name_ru, { size: 18 })] : []),
        ...(dee.registered_address ? [p(dee.registered_address, { size: 18 })] : []),
        ...(dee.tax_id ? [p(`ИНН ${dee.tax_id}`, { size: 18 })] : []),
        ...(dee.kpp ? [p(`КПП ${dee.kpp}`, { size: 18 })] : []),

        blank(),
        p(`${trilingual('Delivery', 'Условия поставки', '交货条件')}: ${input.incoterms}`, { bold: true }),
        ...(input.container
          ? [p(`${trilingual('Container', 'Контейнер', '集装箱')}: ${input.container}`)]
          : []),
        ...(input.countryStation
          ? [p(`${trilingual('Country / Station', 'Страна / Станция', '国家 / 车站')}: ${input.countryStation}`)]
          : []),

        ...(input.bankRoute ? [
          blank(),
          subheading(trilingual('Bank details', 'Банковские реквизиты', '银行信息')),
          p(`${trilingual('Beneficiary', 'Получатель', '受益人')}: ${input.bankRoute.account_holder}`, { size: 18 }),
          p(input.bankRoute.bank_name, { size: 18 }),
          ...(input.bankRoute.bank_address ? [p(input.bankRoute.bank_address, { size: 18 })] : []),
          ...(input.bankRoute.account_number
            ? [p(`Account: ${input.bankRoute.account_number}`, { size: 18 })] : []),
          ...(input.bankRoute.iban ? [p(`IBAN: ${input.bankRoute.iban}`, { size: 18 })] : []),
          p(`SWIFT: ${input.bankRoute.swift}`, { size: 18 }),
          p(`${trilingual('Currency', 'Валюта', '货币')}: ${input.bankRoute.currency}`, { size: 18 }),
        ] : []),

        blank(),
        buildTable(cols, rows),
        blank(),
        p(`${trilingual('TOTAL', 'ИТОГО', '总计')}: ${formatMoney(input.totalMinor, input.currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),

        blank(),
        subheading(trilingual('Safety declarations', 'Декларации о безопасности', '安全声明')),
        p(SAFETY_RU, { size: 18 }),
        p(SAFETY_CN, { size: 18 }),

        blank(),
        subheading(trilingual('CEO', 'Генеральный директор', '总经理')),
        p('_______________________   盖章'),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
