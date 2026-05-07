// =============================================================================
// NAK — Транспортная накладная.
// Form per Postanovlenie 2200 (21.12.2020). Russian standard waybill.
// STUB: produces a basic DOCX with header data. Full 17-section form
// to be added later.
// =============================================================================

import type { ContractRow, DocumentLanguage, LineItemRow } from '../types';
import {
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderParty,
  RenderSignature, blank, buildPartyTable, buildProductTable,
  buildSignature, formatDate,
  type ProductCell,
} from './shared';
import { Paragraph, TextRun, AlignmentType } from 'docx';

export interface RenderTnInput {
  reference: string;
  issuedAt: number;
  shipper: RenderParty;     // Грузоотправитель
  consignee: RenderParty;   // Грузополучатель
  signature: RenderSignature;
  contract: ContractRow | null;
  lineItems: LineItemRow[];
  upcomingUpdRef: string | null; // Ref to corresponding UPD
}

export async function renderTn(input: RenderTnInput): Promise<Uint8Array> {
  const issuedDate = formatDate(input.issuedAt);

  // Total weight and packages from line items
  const totalQty = input.lineItems.reduce((sum, li) => sum + li.qty, 0);
  const totalCartons = input.lineItems.reduce((sum, li) => sum + (li.cartons ?? 0), 0);

  const cargoRows: ProductCell[][] = input.lineItems.map((li, i) => [
    { text: String(i + 1) },
    { text: li.invoice_label ?? li.item_description ?? li.product_id },
    { text: String(li.qty) },
    { text: 'шт' },
    { text: String(li.cartons ?? 0) },
  ]);

  const doc = new Document({
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: 'Транспортная накладная', bold: true, size: 28 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: `№ ${input.reference}   от ${issuedDate}`, size: 22 }),
          ],
        }),
        blank(),

        // Раздел 1: Грузоотправитель
        new Paragraph({
          children: [new TextRun({ text: '1. Грузоотправитель (грузовладелец)', bold: true, size: 22 })],
        }),
        buildPartyTable('', input.shipper, 'RU'),
        blank(),

        // Раздел 2: Грузополучатель
        new Paragraph({
          children: [new TextRun({ text: '2. Грузополучатель', bold: true, size: 22 })],
        }),
        buildPartyTable('', input.consignee, 'RU'),
        blank(),

        // Раздел 3: Груз
        new Paragraph({
          children: [new TextRun({ text: '3. Наименование груза', bold: true, size: 22 })],
        }),
        buildProductTable(
          ['№', 'Наименование', 'Кол-во', 'Ед.изм.', 'Кол-во мест (картонов)'],
          cargoRows,
          PORTRAIT_USABLE_DXA,
        ),
        new Paragraph({
          children: [
            new TextRun({ text: `Всего: ${totalQty} шт, мест: ${totalCartons}`, bold: true, size: 22 }),
          ],
        }),
        blank(),

        // Раздел 4: Сопроводительные документы
        new Paragraph({
          children: [new TextRun({ text: '4. Сопроводительные документы на груз', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: input.upcomingUpdRef
                ? `УПД № ${input.upcomingUpdRef} от ${issuedDate}`
                : '—',
              size: 22,
            }),
          ],
        }),
        blank(),

        // Разделы 5-9: пустые placeholder'ы
        new Paragraph({
          children: [new TextRun({ text: '5. Указания грузоотправителя', bold: true, size: 22 })],
        }),
        new Paragraph({ children: [new TextRun({ text: '—', size: 22 })] }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '6. Приём груза', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `Дата приёма: ${issuedDate}`, size: 22 })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '7. Сдача груза', bold: true, size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: `Адрес сдачи: ${input.consignee.addressLocal ?? input.consignee.addressEn ?? '—'}`, size: 22 })],
        }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '10. Перевозчик', bold: true, size: 22 })],
        }),
        new Paragraph({ children: [new TextRun({ text: '(заполняется при отгрузке)', italics: true, size: 22 })] }),
        blank(),

        new Paragraph({
          children: [new TextRun({ text: '11. Транспортное средство', bold: true, size: 22 })],
        }),
        new Paragraph({ children: [new TextRun({ text: '(заполняется при отгрузке)', italics: true, size: 22 })] }),
        blank(),

        buildSignature(input.signature, 'RU'),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
