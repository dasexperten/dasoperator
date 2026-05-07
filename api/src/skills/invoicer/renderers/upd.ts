// =============================================================================
// UPD — Универсальный передаточный документ.
// Form per Postanovlenie 1137 (with edits 534).
// Status 1 = invoice + transfer act combined.
// STUB: produces a basic DOCX with header data. Full form to be added later.
// =============================================================================

import type { ContractRow, DocumentLanguage, LineItemRow } from '../types';
import {
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderBank, RenderParty,
  RenderSignature, blank, buildPartyTable, buildProductTable,
  buildSignature, buildTitle, formatDate, formatMoney,
  type ProductCell,
} from './shared';
import { Paragraph, TextRun, AlignmentType } from 'docx';

export interface RenderUpdInput {
  reference: string;
  issuedAt: number;
  currency: string;
  seller: RenderParty;
  buyer: RenderParty;
  signature: RenderSignature;
  contract: ContractRow | null;
  lineItems: LineItemRow[];
  totalMinor: number;
  vatRatePct: number; // 5 for DEE on USN+VAT
}

export async function renderUpd(input: RenderUpdInput): Promise<Uint8Array> {
  const issuedDate = formatDate(input.issuedAt);
  const vatRateLabel = input.vatRatePct === 0 ? 'Без НДС' : `${input.vatRatePct}%`;

  // Compute totals
  const totalWithoutVat = input.vatRatePct > 0
    ? Math.round(input.totalMinor / (1 + input.vatRatePct / 100))
    : input.totalMinor;
  const totalVat = input.totalMinor - totalWithoutVat;

  const productRows: ProductCell[][] = input.lineItems.map((li, i) => [
    { text: String(i + 1) },
    { text: '' }, // Код товара
    { text: li.invoice_label ?? li.item_description ?? li.product_id },
    { text: '' }, // Код вида товара
    { text: '796' }, // Единица измерения - код
    { text: 'шт' }, // условное
    { text: String(li.qty) },
    { text: formatMoney(li.unit_price_after_disc, input.currency, 4) },
    { text: formatMoney(li.line_amount, input.currency, 2) },
    { text: 'без акциза' },
    { text: vatRateLabel },
    { text: input.vatRatePct > 0 ? formatMoney(Math.round(li.line_amount * input.vatRatePct / (100 + input.vatRatePct)), input.currency, 2) : '0' },
    { text: formatMoney(li.line_amount, input.currency, 2) },
    { text: '' }, // Страна происхождения
    { text: '' }, // Номер ТД
  ]);

  const doc = new Document({
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Универсальный передаточный документ', bold: true, size: 28 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `Статус: 1 (счёт-фактура и передаточный документ)`, size: 22 })],
        }),
        blank(),
        new Paragraph({
          children: [
            new TextRun({ text: `Счёт-фактура № ${input.reference}`, bold: true, size: 24 }),
            new TextRun({ text: `   от ${issuedDate}`, size: 24 }),
          ],
        }),
        blank(),
        buildPartyTable('Продавец', input.seller, 'RU'),
        blank(),
        buildPartyTable('Покупатель', input.buyer, 'RU'),
        blank(),
        new Paragraph({
          children: [new TextRun({ text: 'Валюта: Российский рубль, код 643', size: 22 })],
        }),
        blank(),
        buildProductTable(
          [
            '№', 'Код', 'Наименование', 'Вид', 'Ед.изм. (код)', 'Ед.изм.',
            'Кол-во', 'Цена', 'Сумма без НДС', 'Акциз', 'Ставка НДС',
            'Сумма НДС', 'Сумма с НДС', 'Страна', 'ТД №',
          ],
          productRows,
          PORTRAIT_USABLE_DXA,
        ),
        blank(),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: `Всего без НДС: ${formatMoney(totalWithoutVat, input.currency, 2)} ₽`, size: 22 }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: `НДС (${vatRateLabel}): ${formatMoney(totalVat, input.currency, 2)} ₽`, size: 22 }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: `Итого с НДС: ${formatMoney(input.totalMinor, input.currency, 2)} ₽`, bold: true, size: 24 }),
          ],
        }),
        blank(),
        buildSignature(input.signature, 'RU'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
