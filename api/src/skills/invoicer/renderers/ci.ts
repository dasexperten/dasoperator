// =============================================================================
// CI renderer — Commercial Invoice (Step 4A from the invoicer skill).
// Single-language (EN or RU). Seller may be a company OR a manufacturer
// (e.g. the Factory→DEI leg of a dei_layer chain).
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type { ContractRow, DocumentLanguage, LineItemRow } from '../types';
import {
  RenderBank, RenderParty, RenderSignature, bankBlock, blank, buildTable,
  formatDate, formatMoney, heading, p, partyBlock, signatureBlock,
} from './shared';

export interface RenderCiInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;       // CI is never BILINGUAL — guard upstream
  currency: string;
  seller: RenderParty;
  buyer: RenderParty;
  bank: RenderBank;
  signature: RenderSignature;
  contract: ContractRow | null;
  incoterms: string;
  paymentTerms: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
}

export async function renderCommercialInvoice(input: RenderCiInput): Promise<Uint8Array> {
  const isRu = input.language === 'RU';
  const langLite: 'EN' | 'RU' = isRu ? 'RU' : 'EN';

  const titleEn = 'COMMERCIAL INVOICE';
  const titleRu = 'СЧЁТ-ФАКТУРА (КОММЕРЧЕСКИЙ ИНВОЙС)';

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
    const desc = isRu
      ? (li.description_ru ?? li.description_en ?? li.invoice_label ?? li.product_id)
      : (li.description_en ?? li.description_ru ?? li.invoice_label ?? li.product_id);
    return [
      String(idx + 1),
      desc,
      li.hs_code ?? '',
      li.country_of_origin ?? '',
      String(li.qty),
      isRu ? 'шт.' : 'pcs',
      formatMoney(li.unit_price_after_disc, input.currency),
      formatMoney(li.line_amount, input.currency),
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
        p(`${isRu ? 'Инвойс №' : 'Invoice No.'}: ${input.reference}`, { bold: true }),
        p(`${isRu ? 'Дата' : 'Date'}: ${formatDate(input.issuedAt)}`),
        ...(input.contract
          ? [p(`${isRu ? 'Договор №' : 'Contract No.'}: ${input.contract.contract_no}`)] : []),
        ...(input.contract?.unk_reference
          ? [p(`УНК: ${input.contract.unk_reference}`)] : []),
        blank(),
        ...partyBlock({
          language: langLite, label: isRu ? 'ПРОДАВЕЦ' : 'SELLER', party: input.seller,
        }),
        blank(),
        ...bankBlock(input.bank, langLite),
        blank(),
        ...partyBlock({
          language: langLite, label: isRu ? 'ПОКУПАТЕЛЬ' : 'BUYER', party: input.buyer,
        }),
        blank(),
        p(`${isRu ? 'Условия поставки' : 'Delivery terms'}: ${input.incoterms}`, { bold: true }),
        ...(input.paymentTerms
          ? [p(`${isRu ? 'Условия оплаты' : 'Payment terms'}: ${input.paymentTerms}`)] : []),
        blank(),
        buildTable(cols, rows),
        blank(),
        p(`${isRu ? 'ИТОГО' : 'TOTAL'}: ${formatMoney(input.totalMinor, input.currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),
        blank(),
        ...signatureBlock(input.signature, langLite),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
