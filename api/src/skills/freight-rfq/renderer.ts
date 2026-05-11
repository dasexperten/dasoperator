// =============================================================================
// RFQ — Freight Request for Quotation. English-only. Portrait A4.
//
// Lightweight document — no buyer/seller, no tax IDs, no currency conversion.
// Just: from whom (Das Experten entity) to whom (freight forwarder), what
// cargo, where to pick up, where to deliver, and the standard ask:
//   - quote
//   - transit time
//   - required documents
//   - earliest pickup date
// =============================================================================

import {
  AlignmentType, BorderStyle, Document, HeightRule, Packer, Paragraph, Table,
  TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import type {
  RfqDestinationLocation, RfqIssuerCompany, RfqLineItem, RfqOperation,
  RfqOriginLocation, RfqShipper,
} from './types';

const PORTRAIT_PAGE = {
  size: { width: 11906, height: 16838 },
  margin: { top: 567, right: 720, bottom: 567, left: 720 },
} as const;

const USABLE_DXA = 10500;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const HAIRLINE = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };

const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
} as const;

const HAIRLINE_BORDERS = {
  top: HAIRLINE, bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE,
  insideHorizontal: HAIRLINE, insideVertical: HAIRLINE,
} as const;

function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = d.getUTCFullYear();
  return `${dd}.${mm}.${yy}`;
}

function joinLines(parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p != null && String(p).trim().length > 0).join(', ');
}

function run(text: string, opts: { bold?: boolean; size?: number } = {}): TextRun {
  return new TextRun({
    text,
    bold: opts.bold ?? false,
    size: opts.size ?? 18,  // 9pt
    font: 'Calibri',
  });
}

function para(runs: TextRun[], opts: { alignment?: typeof AlignmentType[keyof typeof AlignmentType]; spacingAfter?: number } = {}): Paragraph {
  const o: any = {
    children: runs,
    spacing: { after: opts.spacingAfter ?? 60 },
  };
  if (opts.alignment !== undefined) o.alignment = opts.alignment;
  return new Paragraph(o);
}

function cell(children: Paragraph[], opts: { width?: number; bg?: string } = {}): TableCell {
  const o: any = {
    children,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.TOP,
  };
  if (opts.width !== undefined) o.width = { size: opts.width, type: WidthType.DXA };
  if (opts.bg !== undefined) o.shading = { fill: opts.bg, type: 'clear', color: 'auto' };
  return new TableCell(o);
}

export interface RenderRfqInput {
  reference: string;
  issuedAt: number;
  issuer: RfqIssuerCompany;
  shipper: RfqShipper;
  operation: RfqOperation;
  lineItems: RfqLineItem[];
  origin: RfqOriginLocation;
  destination: RfqDestinationLocation;
  requestedPickupDate: number | null;
  notes: string | null;
}

export async function renderRfq(input: RenderRfqInput): Promise<Uint8Array> {
  const {
    reference, issuedAt, issuer, shipper, operation, lineItems,
    origin, destination, requestedPickupDate, notes,
  } = input;

  const title = new Paragraph({
    children: [new TextRun({ text: 'FREIGHT REQUEST FOR QUOTATION', bold: true, size: 24, font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
  });

  // Meta row: reference + date.
  const metaTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          cell([para([run('No. ', { bold: true }), run(reference)])], { width: USABLE_DXA / 2 }),
          cell([para([run('Date: ', { bold: true }), run(formatDate(issuedAt))])], { width: USABLE_DXA / 2 }),
        ],
      }),
    ],
  });

  // From / To block.
  const issuerLines = [
    issuer.legal_name,
    issuer.registered_address,
    issuer.email,
  ];
  const shipperLines = [
    shipper.legal_name_en || shipper.trade_name,
    shipper.country,
    shipper.email,
  ];

  const partyTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: [
      new TableRow({
        height: { value: 280, rule: HeightRule.ATLEAST },
        children: [
          cell([para([run('FROM', { bold: true })])], { width: USABLE_DXA / 2, bg: 'F2F2F2' }),
          cell([para([run('TO (FREIGHT FORWARDER)', { bold: true })])], { width: USABLE_DXA / 2, bg: 'F2F2F2' }),
        ],
      }),
      new TableRow({
        children: [
          cell(issuerLines.filter((l): l is string => Boolean(l)).map((l) => para([run(l)]))),
          cell(shipperLines.filter((l): l is string => Boolean(l)).map((l) => para([run(l)]))),
        ],
      }),
    ],
  });

  // Shipment details block.
  const totalQty = lineItems.reduce((s, li) => s + (li.qty ?? 0), 0);
  const totalCartons = lineItems.reduce((s, li) => s + (li.cartons ?? 0), 0);

  const originText = joinLines([origin.name, origin.address, origin.city, origin.country]) || 'TBD';
  const destText = joinLines([destination.name, destination.address, destination.city, destination.country]) || 'TBD';

  const detailsRows: TableRow[] = [
    new TableRow({
      children: [
        cell([para([run('Reference:', { bold: true })])], { width: 2800 }),
        cell([para([run(operation.reference || operation.id)])], { width: USABLE_DXA - 2800 }),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Operation type:', { bold: true })])]),
        cell([para([run(operation.operation_type)])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Pickup from:', { bold: true })])]),
        cell([para([run(originText)])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Deliver to:', { bold: true })])]),
        cell([para([run(destText)])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Incoterms:', { bold: true })])]),
        cell([para([run(operation.incoterms || 'TBD — please advise')])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Requested pickup:', { bold: true })])]),
        cell([para([run(requestedPickupDate ? formatDate(requestedPickupDate) : 'Earliest possible')])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Total units:', { bold: true })])]),
        cell([para([run(totalQty.toLocaleString('en-US') + ' pcs')])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Total cartons:', { bold: true })])]),
        cell([para([run(totalCartons > 0 ? String(totalCartons) : 'TBD')])]),
      ],
    }),
  ];

  const detailsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: detailsRows,
  });

  // Line items table.
  const itemHeader = new TableRow({
    height: { value: 280, rule: HeightRule.ATLEAST },
    children: [
      cell([para([run('#', { bold: true })])], { width: 600, bg: 'F2F2F2' }),
      cell([para([run('SKU', { bold: true })])], { width: 1400, bg: 'F2F2F2' }),
      cell([para([run('Product', { bold: true })])], { width: USABLE_DXA - 600 - 1400 - 1400 - 1400, bg: 'F2F2F2' }),
      cell([para([run('Quantity', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: 1400, bg: 'F2F2F2' }),
      cell([para([run('Cartons', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: 1400, bg: 'F2F2F2' }),
    ],
  });

  const itemRows = lineItems.map((li, i) => {
    const sku = (li.product_id ?? '').toUpperCase().replace(/^PRD_/, '');
    const name = li.product_name || li.invoice_label || sku;
    return new TableRow({
      children: [
        cell([para([run(String(i + 1))])]),
        cell([para([run(sku, { bold: true })])]),
        cell([para([run(name)])]),
        cell([para([run(li.qty.toLocaleString('en-US'))], { alignment: AlignmentType.RIGHT })]),
        cell([para([run(li.cartons != null ? String(li.cartons) : '—')], { alignment: AlignmentType.RIGHT })]),
      ],
    });
  });

  const itemsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: [itemHeader, ...itemRows],
  });

  // Ask block.
  const askIntro = para([run('Please advise the following at your earliest convenience:', { bold: true })], { spacingAfter: 80 });
  const askPoints = [
    '— Estimated freight cost',
    '— Transit time (pickup to delivery)',
    '— Documents required from our side',
    '— Earliest possible pickup date',
    '— Insurance options and cost',
  ].map((line) => para([run(line)], { spacingAfter: 40 }));

  // Notes (optional).
  const notesBlock: Paragraph[] = [];
  if (notes && notes.trim().length > 0) {
    notesBlock.push(para([run('')]));
    notesBlock.push(para([run('Additional notes:', { bold: true })]));
    notes.split(/\r?\n/).forEach((line) => {
      if (line.trim().length > 0) notesBlock.push(para([run(line)]));
    });
  }

  // Signature.
  const signature = [
    para([run('')]),
    para([run('Kind regards,')]),
    para([run(issuer.legal_name, { bold: true })]),
    ...(issuer.email ? [para([run(issuer.email)])] : []),
  ];

  const doc = new Document({
    creator: 'Das Operator',
    title: `RFQ ${reference}`,
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        title,
        metaTable,
        para([run('')]),
        partyTable,
        para([run('')]),
        para([run('SHIPMENT DETAILS', { bold: true })], { spacingAfter: 80 }),
        detailsTable,
        para([run('')]),
        para([run('CARGO', { bold: true })], { spacingAfter: 80 }),
        itemsTable,
        para([run('')]),
        askIntro,
        ...askPoints,
        ...notesBlock,
        ...signature,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
