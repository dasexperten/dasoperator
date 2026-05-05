// =============================================================================
// IS Variant 1 — Brushes / Yangzhou Jinxia format. Step 4C V1 from the skill.
// Bilingual EN+RU, three-party block (Shipper=manufacturer, Buyer=DEE,
// Seller=DEI). Used for toothbrushes (HS 9603xxx) leaving China to Russia.
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type {
  CompanyRow, ContractRow, LineItemRow, ManufacturerBankRouteRow,
  ManufacturerRow, PartnerRow,
} from '../types';
import {
  bilingual, blank, buildTable, formatDate, formatMoney, heading, p, signatureBlock,
  subheading,
} from './shared';

export interface RenderIsV1Input {
  reference: string;
  issuedAt: number;
  currency: string;
  manufacturer: ManufacturerRow;          // shipper (Jinxia)
  ourCompany: CompanyRow;                 // typically DEI on these — the issuer
  buyerCompany: CompanyRow | null;        // DEE for the standard route; optional
  partner: PartnerRow | null;             // ultimate consignee if present
  contract: ContractRow | null;
  bankRoute: ManufacturerBankRouteRow | null;
  incoterms: string;                      // FOB Shanghai default
  consigneeAtTerminal: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
}

function partyBilingualLines(
  legalEn: string | null, legalRu: string | null,
  addressEn: string | null, addressRu: string | null,
  taxId: string | null, label: string
) {
  const out = [subheading(label)];
  if (legalEn || legalRu) out.push(p(bilingual(legalEn ?? '', legalRu ?? ''), { bold: true, size: 18 }));
  if (addressEn || addressRu) out.push(p(bilingual(addressEn ?? '', addressRu ?? ''), { size: 18 }));
  if (taxId) out.push(p(`USCC / ИНН: ${taxId}`, { size: 18 }));
  return out;
}

export async function renderInvoiceSpecBrushes(input: RenderIsV1Input): Promise<Uint8Array> {
  const titleLine1 = 'INVOICE-SPECIFICATION / СЧЁТ-СПЕЦИФИКАЦИЯ';
  const m = input.manufacturer;
  const dei = input.ourCompany;
  const dee = input.buyerCompany;

  const cols = [
    { header: '#', widthPct: 4 },
    { header: 'HS Code', widthPct: 11 },
    { header: bilingual('Origin', 'Страна'), widthPct: 9 },
    { header: bilingual('Description', 'Описание'), widthPct: 30 },
    { header: bilingual('Qty (pcs)', 'Кол-во (шт)'), widthPct: 8 },
    { header: bilingual('Cartons', 'Кор-ов'), widthPct: 8 },
    { header: bilingual('Net (kg)', 'Нетто'), widthPct: 8 },
    { header: bilingual('Gross (kg)', 'Брутто'), widthPct: 8 },
    { header: bilingual('Price', 'Цена'), widthPct: 7 },
    { header: bilingual('Amount', 'Сумма'), widthPct: 7 },
  ];

  const rows: string[][] = input.lineItems.map((li, idx) => {
    const desc = bilingual(
      li.description_en ?? li.invoice_label ?? li.product_id,
      li.description_ru ?? '',
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
      bilingual(li.country_of_origin ?? 'China', 'Китай'),
      desc,
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
    title: `IS-V1 ${input.reference}`,
    sections: [{
      properties: {},
      children: [
        heading(titleLine1),
        blank(),
        p(`${bilingual('Invoice No.', 'Инвойс №')}: ${input.reference}`, { bold: true }),
        p(`${bilingual('Date', 'Дата')}: ${formatDate(input.issuedAt, 'BILINGUAL')}`),
        ...(input.contract
          ? [p(`${bilingual('Contract', 'Договор')}: ${input.contract.contract_no}`)]
          : []),
        ...(input.consigneeAtTerminal
          ? [p(`${bilingual('Consignee at terminal', 'Получатель по ст.')}: ${input.consigneeAtTerminal}`)]
          : []),
        blank(),
        ...partyBilingualLines(
          m.legal_name_en, m.legal_name_ru,
          m.registered_address_en, m.registered_address_ru,
          m.tax_id, bilingual('SHIPPER', 'ОТПРАВИТЕЛЬ'),
        ),
        blank(),
        ...(dee ? partyBilingualLines(
          dee.legal_name, dee.legal_name_ru,
          dee.registered_address, dee.registered_address,
          dee.tax_id, bilingual('BUYER', 'ПОКУПАТЕЛЬ'),
        ) : (input.partner ? partyBilingualLines(
          input.partner.legal_name, input.partner.legal_name_local,
          input.partner.registered_address_local, input.partner.registered_address_local,
          input.partner.tax_id, bilingual('BUYER', 'ПОКУПАТЕЛЬ'),
        ) : [])),
        blank(),
        ...partyBilingualLines(
          dei.legal_name, dei.legal_name_ru,
          dei.registered_address, dei.registered_address,
          dei.tax_id, bilingual('SELLER', 'ПРОДАВЕЦ'),
        ),
        blank(),
        p(`${bilingual('Terms of delivery', 'Условия поставки')}: ${input.incoterms}`, { bold: true }),
        ...(input.bankRoute ? [
          blank(),
          subheading(bilingual('Bank details', 'Банковские реквизиты')),
          p(`${bilingual('Beneficiary', 'Получатель')}: ${input.bankRoute.account_holder}`, { size: 18 }),
          p(input.bankRoute.bank_name, { size: 18 }),
          ...(input.bankRoute.bank_address ? [p(input.bankRoute.bank_address, { size: 18 })] : []),
          ...(input.bankRoute.account_number
            ? [p(`Account: ${input.bankRoute.account_number}`, { size: 18 })] : []),
          ...(input.bankRoute.iban ? [p(`IBAN: ${input.bankRoute.iban}`, { size: 18 })] : []),
          p(`SWIFT: ${input.bankRoute.swift}`, { size: 18 }),
          p(`${bilingual('Currency', 'Валюта')}: ${input.bankRoute.currency}`, { size: 18 }),
        ] : []),
        blank(),
        buildTable(cols, rows),
        blank(),
        p(`${bilingual('TOTAL', 'ИТОГО')}: ${formatMoney(input.totalMinor, input.currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),
        blank(),
        ...signatureBlock(dei, 'BILINGUAL'),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
