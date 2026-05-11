// =============================================================================
// RFQ — Freight Request for Quotation. English-only. Portrait A4.
//
// v2: added logistics calculations so the shipper actually has numbers
//   to quote against — cartons (computed from qty/ctn_qty if not set),
//   gross weight (cartons * ctn_weight_gross_kg), volume CBM per line,
//   and total summary block.
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

// =============================================================================
// Logistics math
// =============================================================================

interface LineLogistics {
  cartons: number;
  cartonsEstimated: boolean;     // true = computed from qty/ctn_qty, not stated
  grossKg: number | null;
  cbm: number | null;            // cubic meters
  cartonDimsMm: string | null;   // "390×290×195 mm" or null
  cartonNote: string | null;     // explanation when ctn data missing
}

function computeLineLogistics(li: RfqLineItem): LineLogistics {
  let cartons = li.cartons ?? 0;
  let cartonsEstimated = false;

  // If cartons not given, derive from qty/ctn_qty.
  if (cartons === 0 && li.ctn_qty && li.ctn_qty > 0) {
    cartons = Math.ceil(li.qty / li.ctn_qty);
    cartonsEstimated = true;
  }

  // Gross weight: cartons * weight per carton.
  let grossKg: number | null = null;
  if (cartons > 0 && li.ctn_weight_gross_kg && li.ctn_weight_gross_kg > 0) {
    grossKg = cartons * li.ctn_weight_gross_kg;
  }

  // Volume: cartons * (L*W*H in cm) / 1_000_000 → CBM
  let cbm: number | null = null;
  let cartonDimsMm: string | null = null;
  if (li.ctn_dim_l_cm && li.ctn_dim_w_cm && li.ctn_dim_h_cm) {
    const oneCartonCbm = (li.ctn_dim_l_cm * li.ctn_dim_w_cm * li.ctn_dim_h_cm) / 1_000_000;
    cbm = cartons > 0 ? cartons * oneCartonCbm : 0;
    cartonDimsMm = `${li.ctn_dim_l_cm}×${li.ctn_dim_w_cm}×${li.ctn_dim_h_cm} cm`;
  }

  // Carton note for transparency.
  let cartonNote: string | null = null;
  if (cartons === 0) {
    cartonNote = 'carton qty unknown — please confirm';
  } else if (cartonsEstimated) {
    cartonNote = `${li.ctn_qty}/ctn`;
  }

  return { cartons, cartonsEstimated, grossKg, cbm, cartonDimsMm, cartonNote };
}

function fmtKg(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' kg';
}

function fmtCbm(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 3 }) + ' m³';
}

// =============================================================================
// Renderer
// =============================================================================

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

  // Pre-compute logistics for every line.
  const lineLogistics = lineItems.map(computeLineLogistics);

  // Totals across lines.
  const totalQty = lineItems.reduce((s, li) => s + (li.qty ?? 0), 0);
  const totalCartons = lineLogistics.reduce((s, l) => s + (l.cartons ?? 0), 0);
  const anyGross = lineLogistics.some((l) => l.grossKg != null);
  const totalGrossKg = anyGross
    ? lineLogistics.reduce((s, l) => s + (l.grossKg ?? 0), 0)
    : null;
  const anyCbm = lineLogistics.some((l) => l.cbm != null);
  const totalCbm = anyCbm
    ? lineLogistics.reduce((s, l) => s + (l.cbm ?? 0), 0)
    : null;

  // How many cartons are estimated vs stated — needed for the disclaimer.
  const hasEstimatedCartons = lineLogistics.some((l) => l.cartonsEstimated);
  const hasMissingDims = lineLogistics.some((l) => l.cbm == null);

  // ------- Title -------
  const title = new Paragraph({
    children: [new TextRun({ text: 'FREIGHT REQUEST FOR QUOTATION', bold: true, size: 24, font: 'Calibri' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
  });

  // ------- Meta row -------
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

  // ------- From / To -------
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

  // ------- Shipment details -------
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
  ];

  const detailsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: detailsRows,
  });

  // ------- Logistics summary (totals at a glance) -------
  const summaryRows: TableRow[] = [
    new TableRow({
      children: [
        cell([para([run('Total units:', { bold: true })])], { width: 3200 }),
        cell([para([run(totalQty.toLocaleString('en-US') + ' pcs')])], { width: USABLE_DXA - 3200 }),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Total cartons:', { bold: true })])]),
        cell([para([run(
          totalCartons > 0
            ? totalCartons.toLocaleString('en-US') + (hasEstimatedCartons ? '  (estimated from carton qty)' : '')
            : 'TBD — please advise'
        )])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Total gross weight:', { bold: true })])]),
        cell([para([run(totalGrossKg != null ? fmtKg(totalGrossKg) + '  (approx)' : 'TBD — carton weight unknown')])]),
      ],
    }),
    new TableRow({
      children: [
        cell([para([run('Total volume:', { bold: true })])]),
        cell([para([run(totalCbm != null ? fmtCbm(totalCbm) + '  (approx)' : 'TBD — carton dimensions unknown')])]),
      ],
    }),
  ];

  const summaryTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: summaryRows,
  });

  // ------- Cargo table (per-SKU with logistics) -------
  // Column widths (DXA totals ~10500)
  const W = {
    num: 500,
    sku: 1100,
    name: 2800,
    qty: 900,
    ctnQty: 700,
    cartons: 800,
    weight: 1100,
    dims: 1400,
    cbm: 1200,
  };

  const itemHeader = new TableRow({
    height: { value: 320, rule: HeightRule.ATLEAST },
    children: [
      cell([para([run('#', { bold: true })])], { width: W.num, bg: 'F2F2F2' }),
      cell([para([run('SKU', { bold: true })])], { width: W.sku, bg: 'F2F2F2' }),
      cell([para([run('Product', { bold: true })])], { width: W.name, bg: 'F2F2F2' }),
      cell([para([run('Qty', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.qty, bg: 'F2F2F2' }),
      cell([para([run('Per ctn', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.ctnQty, bg: 'F2F2F2' }),
      cell([para([run('Cartons', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.cartons, bg: 'F2F2F2' }),
      cell([para([run('Gross', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.weight, bg: 'F2F2F2' }),
      cell([para([run('Carton dims', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.dims, bg: 'F2F2F2' }),
      cell([para([run('Volume', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.cbm, bg: 'F2F2F2' }),
    ],
  });

  const itemRows = lineItems.map((li, i) => {
    const log = lineLogistics[i]!;
    const sku = (li.product_id ?? '').toUpperCase().replace(/^PRD_/, '');
    const name = li.product_name || li.invoice_label || sku;
    const cartonsCell = log.cartons > 0
      ? log.cartons.toLocaleString('en-US') + (log.cartonsEstimated ? ' (est)' : '')
      : '—';
    return new TableRow({
      children: [
        cell([para([run(String(i + 1))])], { width: W.num }),
        cell([para([run(sku, { bold: true })])], { width: W.sku }),
        cell([para([run(name)])], { width: W.name }),
        cell([para([run(li.qty.toLocaleString('en-US'))], { alignment: AlignmentType.RIGHT })], { width: W.qty }),
        cell([para([run(li.ctn_qty != null ? String(li.ctn_qty) : '—')], { alignment: AlignmentType.RIGHT })], { width: W.ctnQty }),
        cell([para([run(cartonsCell)], { alignment: AlignmentType.RIGHT })], { width: W.cartons }),
        cell([para([run(fmtKg(log.grossKg))], { alignment: AlignmentType.RIGHT })], { width: W.weight }),
        cell([para([run(log.cartonDimsMm ?? '—')], { alignment: AlignmentType.RIGHT })], { width: W.dims }),
        cell([para([run(fmtCbm(log.cbm))], { alignment: AlignmentType.RIGHT })], { width: W.cbm }),
      ],
    });
  });

  // Totals row at the bottom of the cargo table.
  const totalsRow = new TableRow({
    children: [
      cell([para([run('')])], { width: W.num, bg: 'F2F2F2' }),
      cell([para([run('')])], { width: W.sku, bg: 'F2F2F2' }),
      cell([para([run('TOTAL', { bold: true })])], { width: W.name, bg: 'F2F2F2' }),
      cell([para([run(totalQty.toLocaleString('en-US'), { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.qty, bg: 'F2F2F2' }),
      cell([para([run('')])], { width: W.ctnQty, bg: 'F2F2F2' }),
      cell([para([run(totalCartons > 0 ? totalCartons.toLocaleString('en-US') : '—', { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.cartons, bg: 'F2F2F2' }),
      cell([para([run(fmtKg(totalGrossKg), { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.weight, bg: 'F2F2F2' }),
      cell([para([run('')])], { width: W.dims, bg: 'F2F2F2' }),
      cell([para([run(fmtCbm(totalCbm), { bold: true })], { alignment: AlignmentType.RIGHT })], { width: W.cbm, bg: 'F2F2F2' }),
    ],
  });

  const itemsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIRLINE_BORDERS,
    rows: [itemHeader, ...itemRows, totalsRow],
  });

  // Footnotes for transparency.
  const footnotes: Paragraph[] = [];
  if (hasEstimatedCartons) {
    footnotes.push(para([run(
      '(est) — carton count computed from order quantity ÷ units-per-carton, ' +
      'not yet physically confirmed by the supplier.',
      { size: 16 }
    )]));
  }
  if (hasMissingDims) {
    footnotes.push(para([run(
      'Carton dimensions and volume for some SKUs are not on file — ' +
      'please request exact values from the supplier if needed for booking.',
      { size: 16 }
    )]));
  }

  // ------- Ask block -------
  const askIntro = para([run('Please advise the following at your earliest convenience:', { bold: true })], { spacingAfter: 80 });
  const askPoints = [
    '— Estimated freight cost',
    '— Transit time (pickup to delivery)',
    '— Documents required from our side',
    '— Earliest possible pickup date',
    '— Insurance options and cost',
  ].map((line) => para([run(line)], { spacingAfter: 40 }));

  // ------- Notes (optional) -------
  const notesBlock: Paragraph[] = [];
  if (notes && notes.trim().length > 0) {
    notesBlock.push(para([run('')]));
    notesBlock.push(para([run('Additional notes:', { bold: true })]));
    notes.split(/\r?\n/).forEach((line) => {
      if (line.trim().length > 0) notesBlock.push(para([run(line)]));
    });
  }

  // ------- Signature -------
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
        para([run('LOGISTICS SUMMARY', { bold: true })], { spacingAfter: 80 }),
        summaryTable,
        para([run('')]),
        para([run('CARGO BREAKDOWN', { bold: true })], { spacingAfter: 80 }),
        itemsTable,
        ...footnotes,
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
