// =============================================================================
// RFQ — Freight Request for Quotation.
// Modern Das Experten brand style. English-only (issuer-facing).
//
// Design system:
//   Fonts:    Manrope (with Calibri fallback at OS level)
//   Palette:  schwarz #1A1A1A · rot #C4302B · gold #D4A017 · paper #FCFAF5
//   Borders:  hairline #D8D4CB
//   Sizes:    title 18pt · section 9.5pt UPPER · body 9pt · micro 8pt
//
// Compact layout designed to fit one A4 page for ≤6 SKUs, two pages above.
// =============================================================================

import {
  AlignmentType, BorderStyle, Document, HeightRule, Packer,
  Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import type {
  RfqDestinationLocation, RfqIssuerCompany, RfqLineItem, RfqOperation,
  RfqOriginLocation, RfqShipper,
} from './types';

// ---------- Page geometry ----------
const PORTRAIT_PAGE = {
  size: { width: 11906, height: 16838 },
  margin: { top: 720, right: 720, bottom: 720, left: 720 },
} as const;

const USABLE_DXA = 10460;

// ---------- Brand tokens ----------
const C = {
  schwarz:   '1A1A1A',
  fg1:       '1A1A1A',
  fg2:       '4A4A4A',
  fg3:       '7A7A7A',
  rot:       'C4302B',
  gold:      'D4A017',
  paper:     'FCFAF5',
  paperSunk: 'F4EFE5',
  hairline:  'D8D4CB',
} as const;

const FONT = 'Manrope';

// ---------- Border helpers ----------
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const HAIR = { style: BorderStyle.SINGLE, size: 4, color: C.hairline };
const HAIR_SCHWARZ = { style: BorderStyle.SINGLE, size: 6, color: C.schwarz };

const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
} as const;

const HAIR_BORDERS = {
  top: HAIR, bottom: HAIR, left: HAIR, right: HAIR,
  insideHorizontal: HAIR, insideVertical: HAIR,
} as const;

const HAIR_INSIDE_ONLY = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: HAIR, insideVertical: HAIR,
} as const;

// ---------- Formatting helpers ----------
function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mm = months[d.getUTCMonth()]!;
  const yy = d.getUTCFullYear();
  return `${dd} ${mm} ${yy}`;
}

function joinLines(parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p != null && String(p).trim().length > 0).join(', ');
}

// Non-breaking space (U+00A0) prevents the renderer from breaking long
// numbers/units across two lines on tight columns. Used as the thousands
// separator and before unit suffixes in every numeric formatter below.
const NBSP = '\u00A0';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, NBSP);
}

function fmtKg(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 }).replace(/,/g, NBSP) + NBSP + 'kg';
}

function fmtCbm(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 3 }).replace(/,/g, NBSP) + NBSP + 'm³';
}

// ---------- Run/paragraph helpers ----------
interface RunOpts {
  bold?: boolean;
  size?: number;
  color?: string;
  upper?: boolean;
}

function run(text: string, opts: RunOpts = {}): TextRun {
  return new TextRun({
    text: opts.upper ? text.toUpperCase() : text,
    bold: opts.bold ?? false,
    size: opts.size ?? 18,
    font: FONT,
    color: opts.color ?? C.fg1,
  });
}

interface ParaOpts {
  alignment?: typeof AlignmentType[keyof typeof AlignmentType];
  spacingAfter?: number;
  spacingBefore?: number;
  indent?: number;
}

function para(runs: TextRun[], opts: ParaOpts = {}): Paragraph {
  const o: any = {
    children: runs,
    spacing: { after: opts.spacingAfter ?? 60, before: opts.spacingBefore ?? 0 },
  };
  if (opts.alignment !== undefined) o.alignment = opts.alignment;
  if (opts.indent !== undefined) o.indent = { left: opts.indent };
  return new Paragraph(o);
}

interface CellOpts {
  width?: number;
  bg?: string;
  vAlign?: 'top' | 'center';
  pad?: { top?: number; bottom?: number; left?: number; right?: number };
  borders?: any;
}

function cell(children: Paragraph[], opts: CellOpts = {}): TableCell {
  const p = opts.pad ?? {};
  const o: any = {
    children,
    margins: {
      top: p.top ?? 100,
      bottom: p.bottom ?? 100,
      left: p.left ?? 140,
      right: p.right ?? 140,
    },
    verticalAlign: opts.vAlign === 'center' ? VerticalAlign.CENTER : VerticalAlign.TOP,
  };
  if (opts.width !== undefined) o.width = { size: opts.width, type: WidthType.DXA };
  if (opts.bg !== undefined) o.shading = { fill: opts.bg, type: 'clear', color: 'auto' };
  if (opts.borders !== undefined) o.borders = opts.borders;
  return new TableCell(o);
}

// ---------- Brand ribbon (3-color stripe) ----------
function brandRibbon(): Table {
  const stripeCell = (color: string) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: '', size: 2 })] })],
    shading: { fill: color, type: 'clear', color: 'auto' },
    width: { size: Math.floor(USABLE_DXA / 3), type: WidthType.DXA },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
  });
  return new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: NO_BORDERS,
    rows: [new TableRow({
      height: { value: 80, rule: HeightRule.EXACT },
      children: [stripeCell(C.schwarz), stripeCell(C.rot), stripeCell(C.gold)],
    })],
  });
}

// ---------- Section label ----------
function sectionLabel(text: string): Paragraph {
  return para(
    [run(text, { bold: true, size: 16, color: C.fg2, upper: true })],
    { spacingBefore: 160, spacingAfter: 80 }
  );
}

// =============================================================================
// Logistics math
// =============================================================================

interface LineLogistics {
  cartons: number;
  cartonsEstimated: boolean;
  grossKg: number | null;
  cbm: number | null;
  cartonDimsMm: string | null;
}

function computeLineLogistics(li: RfqLineItem): LineLogistics {
  let cartons = li.cartons ?? 0;
  let cartonsEstimated = false;
  if (cartons === 0 && li.ctn_qty && li.ctn_qty > 0) {
    cartons = Math.ceil(li.qty / li.ctn_qty);
    cartonsEstimated = true;
  }
  let grossKg: number | null = null;
  if (cartons > 0 && li.ctn_weight_gross_kg && li.ctn_weight_gross_kg > 0) {
    grossKg = cartons * li.ctn_weight_gross_kg;
  }
  let cbm: number | null = null;
  let cartonDimsMm: string | null = null;
  let oneCartonCbm: number | null = null;
  if (li.ctn_volume_m3 && li.ctn_volume_m3 > 0) {
    oneCartonCbm = li.ctn_volume_m3;
  } else if (li.ctn_dim_l_cm && li.ctn_dim_w_cm && li.ctn_dim_h_cm) {
    oneCartonCbm = (li.ctn_dim_l_cm * li.ctn_dim_w_cm * li.ctn_dim_h_cm) / 1_000_000;
  }
  if (li.ctn_dim_l_cm && li.ctn_dim_w_cm && li.ctn_dim_h_cm) {
    cartonDimsMm = `${li.ctn_dim_l_cm}×${li.ctn_dim_w_cm}×${li.ctn_dim_h_cm} cm`;
  }
  if (oneCartonCbm != null) cbm = cartons > 0 ? cartons * oneCartonCbm : 0;
  return { cartons, cartonsEstimated, grossKg, cbm, cartonDimsMm };
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

  const lineLogistics = lineItems.map(computeLineLogistics);
  const totalQty     = lineItems.reduce((s, li) => s + (li.qty ?? 0), 0);
  const totalCartons = lineLogistics.reduce((s, l) => s + (l.cartons ?? 0), 0);
  const anyGross     = lineLogistics.some((l) => l.grossKg != null);
  const totalGrossKg = anyGross ? lineLogistics.reduce((s, l) => s + (l.grossKg ?? 0), 0) : null;
  const anyCbm       = lineLogistics.some((l) => l.cbm != null);
  const totalCbm     = anyCbm ? lineLogistics.reduce((s, l) => s + (l.cbm ?? 0), 0) : null;
  const hasEstimatedCartons = lineLogistics.some((l) => l.cartonsEstimated);
  const hasMissingDims      = lineLogistics.some((l) => l.cbm == null);

  // Dense mode if many SKUs.
  const dense = lineItems.length > 6;

  // ===========================================================================
  // HEADER
  // ===========================================================================
  const headerLeft = [
    para([run('FREIGHT RFQ', { bold: true, size: 14, color: C.rot, upper: true })],
      { spacingAfter: 40 }),
    para([run(reference, { bold: true, size: 36, color: C.schwarz })],
      { spacingAfter: 0 }),
  ];

  const headerRight = [
    para([
      run('ISSUED ', { size: 14, color: C.fg3, upper: true }),
      run(formatDate(issuedAt), { size: 14, color: C.fg1, bold: true }),
    ], { alignment: AlignmentType.RIGHT, spacingAfter: 40 }),
    para([run(issuer.legal_name, { bold: true, size: 18, color: C.fg1 })],
      { alignment: AlignmentType.RIGHT, spacingAfter: 20 }),
    ...(issuer.registered_address
      ? [para([run(issuer.registered_address, { size: 14, color: C.fg3 })],
          { alignment: AlignmentType.RIGHT, spacingAfter: 20 })]
      : []),
    ...(issuer.email
      ? [para([run(issuer.email, { size: 14, color: C.fg3 })],
          { alignment: AlignmentType.RIGHT })]
      : []),
  ];

  const headerTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [Math.floor(USABLE_DXA * 0.45), Math.floor(USABLE_DXA * 0.55)],
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [
        cell(headerLeft,
          { width: Math.floor(USABLE_DXA * 0.45),
            pad: { top: 0, left: 0, right: 0, bottom: 0 } }),
        cell(headerRight,
          { width: Math.floor(USABLE_DXA * 0.55),
            pad: { top: 0, left: 0, right: 0, bottom: 0 } }),
      ],
    })],
  });

  // ===========================================================================
  // FORWARDER (TO) — card
  // ===========================================================================
  const shipperBlock = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    borders: HAIR_BORDERS,
    rows: [new TableRow({
      children: [
        cell([
          para([run('Freight forwarder', { size: 14, color: C.fg3, upper: true })],
            { spacingAfter: 40 }),
          para([run(shipper.legal_name_en || shipper.trade_name,
            { bold: true, size: 22, color: C.fg1 })], { spacingAfter: 30 }),
          ...(shipper.country
            ? [para([run(shipper.country, { size: 16, color: C.fg2 })],
                { spacingAfter: 20 })]
            : []),
          ...(shipper.email
            ? [para([run(shipper.email, { size: 14, color: C.fg3 })])]
            : []),
        ], { pad: { top: 160, bottom: 160, left: 220, right: 220 } }),
      ],
    })],
  });

  // ===========================================================================
  // SHIPMENT DETAILS — key/value list
  // ===========================================================================
  const originText = joinLines([origin.name, origin.address, origin.city, origin.country]) || 'TBD';
  const destText   = joinLines([destination.name, destination.address, destination.city, destination.country]) || 'TBD';

  function kvRow(label: string, value: string, opts: { strong?: boolean } = {}): TableRow {
    return new TableRow({
      children: [
        cell([para([run(label, { size: 14, color: C.fg3, upper: true })])],
          { width: 2800, pad: { top: 90, bottom: 90, left: 0, right: 100 } }),
        cell([para([run(value, { size: 18, color: C.fg1, bold: opts.strong ?? false })])],
          { width: USABLE_DXA - 2800, pad: { top: 90, bottom: 90, left: 0, right: 0 } }),
      ],
    });
  }

  const detailsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [2800, USABLE_DXA - 2800],
    borders: HAIR_INSIDE_ONLY,
    rows: [
      kvRow('Reference', operation.reference || operation.id, { strong: true }),
      kvRow('Operation type', operation.operation_type),
      kvRow('Pickup from', originText),
      kvRow('Deliver to', destText),
      kvRow('Incoterms', operation.incoterms || 'TBD — please advise'),
      kvRow('Requested pickup',
        requestedPickupDate ? formatDate(requestedPickupDate) : 'Earliest possible'),
    ],
  });

  // ===========================================================================
  // LOGISTICS SUMMARY — 4 KPI tiles
  // ===========================================================================
  function kpiTile(label: string, value: string, sub?: string): TableCell {
    return cell([
      para([run(label, { size: 14, color: C.fg3, upper: true })],
        { spacingAfter: 60 }),
      para([run(value, { bold: true, size: 26, color: C.fg1 })],
        { spacingAfter: sub ? 30 : 0 }),
      ...(sub ? [para([run(sub, { size: 12, color: C.fg3 })])] : []),
    ], {
      width: Math.floor(USABLE_DXA / 4),
      bg: C.paperSunk,
      pad: { top: 140, bottom: 140, left: 160, right: 160 },
      borders: {
        top: HAIR, bottom: HAIR, left: HAIR, right: HAIR,
        insideHorizontal: NO_BORDER, insideVertical: HAIR,
      },
    });
  }

  const summaryTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [Math.floor(USABLE_DXA / 4), Math.floor(USABLE_DXA / 4), Math.floor(USABLE_DXA / 4), Math.floor(USABLE_DXA / 4)],
    borders: HAIR_INSIDE_ONLY,
    rows: [new TableRow({
      children: [
        kpiTile('Units', fmtNum(totalQty), 'pieces'),
        kpiTile('Cartons',
          totalCartons > 0 ? fmtNum(totalCartons) : 'TBD',
          hasEstimatedCartons ? 'estimated' : undefined),
        kpiTile('Weight',
          totalGrossKg != null ? fmtKg(totalGrossKg) : 'TBD',
          totalGrossKg != null ? 'gross, approx' : 'carton weight unknown'),
        kpiTile('Volume',
          totalCbm != null ? fmtCbm(totalCbm) : 'TBD',
          totalCbm != null ? 'approx' : 'carton dims unknown'),
      ],
    })],
  });

  // ===========================================================================
  // CARGO BREAKDOWN
  // ===========================================================================
  const W = {
    num:     300,
    sku:     900,
    name:    2500,
    qty:     900,
    ctnQty:  640,
    cartons: 820,
    weight:  1200,
    dims:    1400,
    cbm:     1280,
  };
  // Sum: 300+900+2500+900+640+820+1200+1400+1280 = 9940

  const padRow = dense
    ? { top: 60, bottom: 60, left: 140, right: 140 }
    : { top: 100, bottom: 100, left: 140, right: 140 };

  function thCell(text: string, width: number, alignRight = false): TableCell {
    const paraOpts: ParaOpts = {};
    if (alignRight) paraOpts.alignment = AlignmentType.RIGHT;
    return cell([
      para([run(text, { bold: true, size: 14, color: C.fg2, upper: true })], paraOpts),
    ], {
      width,
      bg: C.paperSunk,
      pad: { top: 120, bottom: 120, left: 140, right: 140 },
      borders: {
        top: HAIR_SCHWARZ, bottom: HAIR_SCHWARZ, left: NO_BORDER, right: NO_BORDER,
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
      },
    });
  }

  const itemHeader = new TableRow({
    children: [
      thCell('#',       W.num),
      thCell('SKU',     W.sku),
      thCell('Product', W.name),
      thCell('Qty',     W.qty,     true),
      thCell('U/ctn',   W.ctnQty,  true),
      thCell('Ctns',    W.cartons, true),
      thCell('Gross',   W.weight,  true),
      thCell('Dims',    W.dims,    true),
      thCell('Volume',  W.cbm,     true),
    ],
  });

  function bodyCell(p: Paragraph[], width: number): TableCell {
    return cell(p, {
      width,
      pad: padRow,
      borders: {
        top: NO_BORDER, bottom: HAIR,
        left: NO_BORDER, right: NO_BORDER,
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
      },
    });
  }

  const itemRows = lineItems.map((li, i) => {
    const log = lineLogistics[i]!;
    const sku  = (li.product_id ?? '').toUpperCase().replace(/^PRD_/, '');
    const name = li.product_name || li.invoice_label || sku;
    const cartonsCell = log.cartons > 0
      ? fmtNum(log.cartons) + (log.cartonsEstimated ? ' (est)' : '')
      : '—';
    const size = dense ? 16 : 18;
    return new TableRow({
      children: [
        bodyCell([para([run(String(i + 1), { size, color: C.fg3 })])], W.num),
        bodyCell([para([run(sku, { bold: true, size, color: C.fg1 })])], W.sku),
        bodyCell([para([run(name, { size, color: C.fg1 })])], W.name),
        bodyCell([para([run(fmtNum(li.qty), { bold: true, size, color: C.fg1 })],
          { alignment: AlignmentType.RIGHT })], W.qty),
        bodyCell([para([run(li.ctn_qty != null ? String(li.ctn_qty) : '—', { size, color: C.fg2 })],
          { alignment: AlignmentType.RIGHT })], W.ctnQty),
        bodyCell([para([run(cartonsCell, { bold: log.cartons > 0, size, color: C.fg1 })],
          { alignment: AlignmentType.RIGHT })], W.cartons),
        bodyCell([para([run(log.grossKg != null ? fmtKg(log.grossKg) : '—',
          { size, color: log.grossKg != null ? C.fg1 : C.fg3 })],
          { alignment: AlignmentType.RIGHT })], W.weight),
        bodyCell([para([run(log.cartonDimsMm ?? '—',
          { size, color: log.cartonDimsMm ? C.fg2 : C.fg3 })],
          { alignment: AlignmentType.RIGHT })], W.dims),
        bodyCell([para([run(log.cbm != null ? fmtCbm(log.cbm) : '—',
          { size, color: log.cbm != null ? C.fg1 : C.fg3 })],
          { alignment: AlignmentType.RIGHT })], W.cbm),
      ],
    });
  });

  function totalsCell(p: Paragraph[], width: number): TableCell {
    return cell(p, {
      width,
      bg: C.paper,
      pad: { top: 90, bottom: 90, left: 140, right: 140 },
      borders: {
        top: HAIR_SCHWARZ, bottom: HAIR_SCHWARZ,
        left: NO_BORDER, right: NO_BORDER,
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
      },
    });
  }

  const totalsRow = new TableRow({
    children: [
      totalsCell([para([run('')])], W.num),
      totalsCell([para([run('')])], W.sku),
      totalsCell([para([run('TOTAL', { bold: true, size: 14, color: C.fg2, upper: true })])], W.name),
      totalsCell([para([run(fmtNum(totalQty), { bold: true, size: 16, color: C.fg1 })],
        { alignment: AlignmentType.RIGHT })], W.qty),
      totalsCell([para([run('')])], W.ctnQty),
      totalsCell([para([run(totalCartons > 0 ? fmtNum(totalCartons) : '—',
        { bold: true, size: 16, color: C.fg1 })],
        { alignment: AlignmentType.RIGHT })], W.cartons),
      totalsCell([para([run(fmtKg(totalGrossKg), { bold: true, size: 16, color: C.fg1 })],
        { alignment: AlignmentType.RIGHT })], W.weight),
      totalsCell([para([run('')])], W.dims),
      totalsCell([para([run(fmtCbm(totalCbm), { bold: true, size: 16, color: C.fg1 })],
        { alignment: AlignmentType.RIGHT })], W.cbm),
    ],
  });

  const itemsTable = new Table({
    width: { size: USABLE_DXA, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: [W.num, W.sku, W.name, W.qty, W.ctnQty, W.cartons, W.weight, W.dims, W.cbm],
    borders: NO_BORDERS,
    rows: [itemHeader, ...itemRows, totalsRow],
  });

  // Footnotes
  const footnotes: Paragraph[] = [];
  if (hasEstimatedCartons) {
    footnotes.push(para([
      run('(est)', { size: 14, color: C.fg3, bold: true }),
      run('  carton count computed from order quantity ÷ units-per-carton, not yet physically confirmed by supplier.', { size: 14, color: C.fg3 }),
    ], { spacingBefore: 100 }));
  }
  if (hasMissingDims) {
    footnotes.push(para([
      run('Note', { size: 14, color: C.fg3, bold: true }),
      run('  carton dimensions for some SKUs are not on file — please request exact values from supplier if needed for booking.', { size: 14, color: C.fg3 }),
    ]));
  }

  // ===========================================================================
  // ASK
  // ===========================================================================
  const askIntro = para([
    run('We would appreciate the following at your earliest convenience',
      { bold: true, size: 18, color: C.fg1 }),
  ], { spacingBefore: 100, spacingAfter: 60 });

  const askPoints = [
    'Estimated freight cost',
    'Transit time (pickup to delivery)',
    'Documents required from our side',
    'Earliest possible pickup date',
    'Insurance options and cost',
  ].map((line) => para([
    run('— ', { color: C.rot, bold: true }),
    run(line, { color: C.fg1 }),
  ], { spacingAfter: 40, indent: 200 }));

  // ===========================================================================
  // NOTES
  // ===========================================================================
  const notesBlock: Paragraph[] = [];
  if (notes && notes.trim().length > 0) {
    notesBlock.push(sectionLabel('Additional notes'));
    notes.split(/\r?\n/).forEach((line) => {
      if (line.trim().length > 0) {
        notesBlock.push(para([run(line, { color: C.fg2 })], { spacingAfter: 40 }));
      }
    });
  }

  // ===========================================================================
  // FOOTER
  // ===========================================================================
  const footer: Paragraph[] = [
    para([run('')], { spacingBefore: 200 }),
    para([run('Kind regards,', { color: C.fg2, size: 18 })], { spacingAfter: 60 }),
    para([run(issuer.legal_name, { bold: true, size: 20, color: C.fg1 })],
      { spacingAfter: 30 }),
    ...(issuer.email
      ? [para([run(issuer.email, { color: C.fg3, size: 14 })])]
      : []),
  ];

  // ===========================================================================
  // ASSEMBLE
  // ===========================================================================
  const doc = new Document({
    creator: 'Das Operator',
    title: `RFQ ${reference}`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 18, color: C.fg1 },
        },
      },
    },
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        headerTable,
        para([run('')], { spacingBefore: 80, spacingAfter: 80 }),
        brandRibbon(),
        sectionLabel('To'),
        shipperBlock,
        sectionLabel('Shipment details'),
        detailsTable,
        sectionLabel('Logistics summary'),
        summaryTable,
        sectionLabel('Cargo breakdown'),
        itemsTable,
        ...footnotes,
        askIntro,
        ...askPoints,
        ...notesBlock,
        ...footer,
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
