// =============================================================================
// TN — Транспортная накладная.
// Form per Postanovlenie 2200 (21.12.2020). Russian standard waybill.
// STUB: produces a basic DOCX with header data.
// Full 17-section official form will replace this once user provides exact layout.
// =============================================================================

import type { ContractRow, LineItemRow } from '../types';
import {
  Document, Packer, LANDSCAPE_PAGE, LANDSCAPE_USABLE_DXA, RenderParty,
  RenderSignature, blank, buildProductTable, buildSignature, formatDate,
  pickLineLabel,
  type ProductCell,
} from './shared';
import { Paragraph, TextRun, AlignmentType } from 'docx';

export interface RenderTnInput {
  reference: string;
  issuedAt: number;
  shipper: RenderParty;
  consignee: RenderParty;
  signature: RenderSignature;
  contract: ContractRow | null;
  lineItems: LineItemRow[];
  upcomingUpdRef: string | null;
}

function partyBlock(party: RenderParty): Paragraph[] {
  const lines: Paragraph[] = [
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
      children: [new TextRun({ text: addr, size: 20 })],
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

export async function renderTn(input: RenderTnInput): Promise<Uint8Array> {
  const issuedDate = formatDate(input.issuedAt);

  const totalQty = input.lineItems.reduce((sum, li) => sum + li.qty, 0);
  const totalCartons = input.lineItems.reduce((sum, li) => sum + (li.cartons ?? 0), 0);

  const cargoHeaders = [
    { text: '№' }, { text: 'Наименование' }, { text: 'Кол-во' },
    { text: 'Ед.' }, { text: 'Картоны' },
  ];
  const colW = Math.floor(LANDSCAPE_USABLE_DXA / cargoHeaders.length);
  const widths = cargoHeaders.map(() => colW);

  const cargoRows: ProductCell[][] = input.lineItems.map((li, i) => [
    { text: String(i + 1) },
    { text: pickLineLabel(li, { kind: 'TN' }) },
    { text: String(li.qty) },
    { text: 'шт' },
    { text: String(li.cartons ?? 0) },
  ]);

  const doc = new Document({
    sections: [{
      properties: { page: LANDSCAPE_PAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Транспортная накладная', bold: true, size: 28 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `№ ${input.reference}   от ${issuedDate}`, size: 22 })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '1. Грузоотправитель', bold: true, size: 22 })],
        }),
        ...partyBlock(input.shipper),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '2. Грузополучатель', bold: true, size: 22 })],
        }),
        ...partyBlock(input.consignee),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '3. Наименование груза', bold: true, size: 22 })],
        }),
        buildProductTable({
          totalWidthDxa: LANDSCAPE_USABLE_DXA,
          widths, headers: cargoHeaders, rows: cargoRows,
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Всего: ${totalQty} шт, мест (картонов): ${totalCartons}`,
            bold: true, size: 22,
          })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '4. Сопроводительные документы', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({
            text: input.upcomingUpdRef ? `УПД № ${input.upcomingUpdRef} от ${issuedDate}` : '—',
            size: 22,
          })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '6. Приём груза', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `Дата приёма: ${issuedDate}`, size: 22 })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '10. Перевозчик', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: '(заполняется при отгрузке)', italics: true, size: 22 })],
        }),
        blank(),

        ...buildSignature(input.signature, 'RU'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
