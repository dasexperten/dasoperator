// =============================================================================
// CI renderer — Commercial Invoice. Step 4A from the invoicer skill.
// Single language (EN or RU). For BILINGUAL on a CI we still render in EN.
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type {
  BankAccountSelection, CompanyRow, ContractRow, DocumentLanguage, LineItemRow,
  PartnerRow,
} from '../types';
import {
  blank, buildTable, buyerBlock, formatDate, formatMoney, heading, p, sellerBlock,
  signatureBlock, subheading,
} from './shared';

export interface RenderCiInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;
  currency: string;
  ourCompany: CompanyRow;
  partner: PartnerRow;
  contract: ContractRow | null;
  bank: BankAccountSelection;
  incoterms: string;
  lineItems: LineItemRow[];
  totalMinor: number;
}

export async function renderCommercialInvoice(input: RenderCiInput): Promise<Uint8Array> {
  const { language, currency } = input;
  const isRu = language === 'RU';

  const titleEn = 'COMMERCIAL INVOICE';
  const titleRu = 'СЧЁТ-ФАКТУРА (КОММЕРЧЕСКИЙ ИНВОЙС)';
  const refLabel = isRu ? 'Инвойс №' : 'Invoice No.';
  const dateLabel = isRu ? 'Дата' : 'Date';
  const contractLabel = isRu ? 'Договор №' : 'Contract No.';
  const incotermsLabel = isRu ? 'Условия поставки' : 'Delivery terms';
  const totalLabel = isRu ? 'ИТОГО' : 'TOTAL';

  // Line item table — # | Description | HS Code | Origin | Qty | Unit | Price | Total
  const cols = [
    { header: '#', widthPct: 4 },
    { header: isRu ? 'Описание' : 'Description', widthPct: 32 },
    { header: isRu ? 'Код ТН ВЭД' : 'HS Code', widthPct: 11 },
    { header: isRu ? 'Страна' : 'Origin', widthPct: 9 },
    { header: isRu ? 'Кол-во' : 'Qty', widthPct: 7 },
    { header: isRu ? 'Ед.' : 'Unit', widthPct: 6 },
    { header: isRu ? 'Цена' : 'Unit Price', widthPct: 14 },
    { header: isRu ? 'Сумма' : 'Total', widthPct: 17 },
  ];

  const rows: string[][] = input.lineItems.map((li, idx) => {
    const desc = (isRu
      ? (li.description_ru ?? li.description_en ?? li.invoice_label ?? li.product_id)
      : (li.description_en ?? li.description_ru ?? li.invoice_label ?? li.product_id));
    return [
      String(idx + 1),
      desc,
      li.hs_code ?? '',
      li.country_of_origin ?? '',
      String(li.qty),
      isRu ? 'шт.' : 'pcs',
      formatMoney(li.unit_price_after_disc, currency),
      formatMoney(li.line_amount, currency),
    ];
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `${titleEn} ${input.reference}`,
    sections: [{
      properties: {},
      children: [
        heading(isRu ? titleRu : titleEn),
        blank(),
        p(`${refLabel}: ${input.reference}`, { bold: true }),
        p(`${dateLabel}: ${formatDate(input.issuedAt, language)}`),
        ...(input.contract ? [p(`${contractLabel}: ${input.contract.contract_no}`)] : []),
        ...(input.contract?.unk_reference
          ? [p(`УНК: ${input.contract.unk_reference}`)]
          : []),
        blank(),
        ...sellerBlock(input.ourCompany, language, input.bank),
        blank(),
        ...buyerBlock(input.partner, language),
        blank(),
        p(`${incotermsLabel}: ${input.incoterms}`, { bold: true }),
        ...(input.partner.payment_terms
          ? [p(`${isRu ? 'Условия оплаты' : 'Payment terms'}: ${input.partner.payment_terms}`)]
          : []),
        blank(),
        buildTable(cols, rows),
        blank(),
        p(`${totalLabel}: ${formatMoney(input.totalMinor, currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),
        blank(),
        subheading(isRu ? 'Подпись продавца' : 'Seller signature'),
        ...signatureBlock(input.ourCompany, language),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
