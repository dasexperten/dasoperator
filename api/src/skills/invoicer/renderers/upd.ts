// =============================================================================
// UPD — Универсальный передаточный документ.
// Form per Postanovlenie 1137 (with edits 534).
// Status 1 = invoice + transfer act combined.
// STUB: produces a basic DOCX with header data and product table.
// Full official 17-column form will replace this once user provides exact layout.
// =============================================================================

import type { ContractRow, LineItemRow } from '../types';
import {
  Document, Packer, LANDSCAPE_PAGE, LANDSCAPE_USABLE_DXA, RenderParty,
  RenderSignature, blank, buildProductTable, buildSignature, formatDate,
  pickLineLabel,
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
  vatRatePct: number;
}

function partyBlock(label: string, party: RenderParty): Paragraph[] {
  const lines: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: `${label}:`, bold: true, size: 22 })],
    }),
    new Paragraph({
      children: [new TextRun({
        text: party.legalNameLocal ?? party.legalNameEn ?? '',
        bold: true, size: 22,
      })],
    }),
  ];
  const addr = party.addressLocal ?? party.addressEn;
  if (addr) {
    lines.push(new Paragraph({
      children: [new TextRun({ text: `Адрес: ${addr}`, size: 20 })],
    }));
  }
  const idParts: string[] = [];
  if (party.inn) idParts.push(`ИНН ${party.inn}`);
  else if (party.taxId) idParts.push(`ИНН ${party.taxId}`);
  if (party.kpp) idParts.push(`КПП ${party.kpp}`);
  if (idParts.length > 0) {
    lines.push(new Paragraph({
      children: [new TextRun({ text: idParts.join(' / '), size: 20 })],
    }));
  }
  return lines;
}

function fmt(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function renderUpd(input: RenderUpdInput): Promise<Uint8Array> {
  const issuedDate = formatDate(input.issuedAt);
  const vatRateLabel = input.vatRatePct === 0 ? 'Без НДС' : `${input.vatRatePct}%`;

  const totalWithoutVat = input.vatRatePct > 0
    ? input.totalMinor / (1 + input.vatRatePct / 100)
    : input.totalMinor;
  const totalVat = input.totalMinor - totalWithoutVat;

  const productHeaders = [
    { text: '№' }, { text: 'Наименование' }, { text: 'Ед.' },
    { text: 'Кол-во' }, { text: 'Цена' }, { text: 'Без НДС' },
    { text: 'Ставка' }, { text: 'НДС' }, { text: 'С НДС' },
  ];
  const colW = Math.floor(LANDSCAPE_USABLE_DXA / productHeaders.length);
  const widths = productHeaders.map(() => colW);

  const rows: ProductCell[][] = input.lineItems.map((li, i) => {
    const lineWithVat = li.line_amount;
    const lineNoVat = input.vatRatePct > 0
      ? lineWithVat / (1 + input.vatRatePct / 100)
      : lineWithVat;
    const lineVat = lineWithVat - lineNoVat;
    return [
      { text: String(i + 1) },
      { text: pickLineLabel(li, { kind: 'UPD' }) },
      { text: 'шт' },
      { text: String(li.qty) },
      { text: fmt(li.unit_price_after_disc) },
      { text: fmt(lineNoVat) },
      { text: vatRateLabel },
      { text: fmt(lineVat) },
      { text: fmt(lineWithVat) },
    ];
  });

  const doc = new Document({
    sections: [{
      properties: { page: LANDSCAPE_PAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Универсальный передаточный документ', bold: true, size: 28 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Статус: 1 (счёт-фактура и передаточный документ)', size: 20 })],
        }),
        blank(),
        new Paragraph({
          children: [
            new TextRun({ text: `Счёт-фактура № ${input.reference}`, bold: true, size: 24 }),
            new TextRun({ text: `   от ${issuedDate}`, size: 24 }),
          ],
        }),
        blank(),
        ...partyBlock('Продавец', input.seller),
        blank(),
        ...partyBlock('Покупатель', input.buyer),
        blank(),
        new Paragraph({
          children: [new TextRun({ text: 'Валюта: Российский рубль, код 643', size: 22 })],
        }),
        blank(),
        buildProductTable({
          totalWidthDxa: LANDSCAPE_USABLE_DXA,
          widths, headers: productHeaders, rows,
        }),
        blank(),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `Всего без НДС: ${fmt(totalWithoutVat)} ₽`, size: 22 })],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `НДС (${vatRateLabel}): ${fmt(totalVat)} ₽`, size: 22 })],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `Итого с НДС: ${fmt(input.totalMinor)} ₽`, bold: true, size: 24 })],
        }),
        blank(),
        ...buildSignature(input.signature, 'RU'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
