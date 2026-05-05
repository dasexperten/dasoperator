// =============================================================================
// Renderer helpers — unified compact design (Phase 2.0c-5d).
// All four renderers (CI / PL / IS-V1 / IS-V2) consume these helpers so
// typography and spacing stay in lock-step across portrait and landscape
// layouts.
//
// Typography
//   Title         11 pt bold, centered, em-dashes ` — ` between segments
//   Section label  9 pt bold (party header / table header)
//   Body          8 pt regular
//   Footer/safety  7 pt regular
//
// Tables are full page width:
//   Portrait usable = 10500 DXA (PORTRAIT_USABLE_DXA)
//   Landscape usable = 15400 DXA (LANDSCAPE_USABLE_DXA)
//
// Cell margins: top/bottom 80, left/right 120 (DXA). Header rows and TOTAL
// rows on product tables get F2F2F2 shading.
//
// docx@9 quirk: when section.properties.page.size.orientation === LANDSCAPE,
// docx internally swaps width/height before emitting w:pgSz. Both PAGE
// constants below feed PORTRAIT-shaped numbers (width=11906, height=16838)
// and let the swap produce the right XML for landscape.
// =============================================================================

import {
  AlignmentType, BorderStyle, Document, Packer, PageOrientation, Paragraph,
  ShadingType, Table, TableCell, TableLayoutType, TableRow, TextRun,
  VerticalAlign, WidthType,
} from 'docx';

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

// =============================================================================
// Public shapes
// =============================================================================

export type Language = 'EN' | 'RU' | 'BILINGUAL';

export interface RenderParty {
  legalNameEn: string | null;
  legalNameLocal: string | null;
  legalNameCn: string | null;
  addressEn: string | null;
  addressLocal: string | null;
  taxId: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  registrationNo: string | null;
  email: string | null;
}

export interface RenderBank {
  bankName: string;
  bankAddress: string | null;
  accountNumber: string;
  iban: string | null;
  swift: string | null;
  bik: string | null;
  correspondentAccount: string | null;
  accountHolder: string;
  currency: string;
}

export interface RenderSignature {
  name: string | null;
  titleEn: string | null;
  titleRu: string | null;
}

// =============================================================================
// Constants
// =============================================================================

export const PORTRAIT_USABLE_DXA = 10500;
export const LANDSCAPE_USABLE_DXA = 15400;
const SHADE_GRAY = 'F2F2F2';

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

const CELL_MARGINS_PARTY = {
  top: 80, bottom: 80, left: 120, right: 120,
} as const;

const CELL_MARGINS_TABLE = {
  top: 40, bottom: 40, left: 80, right: 80,
} as const;

// Page setup. Margins: top/bottom 1.0 cm = 567 DXA; left/right 1.27 cm = 720 DXA.
export const PORTRAIT_PAGE = {
  size: { width: 11906, height: 16838 },
  margin: { top: 567, right: 720, bottom: 567, left: 720 },
} as const;

export const LANDSCAPE_PAGE = {
  size: {
    orientation: PageOrientation.LANDSCAPE,
    width: 11906,
    height: 16838,
  },
  margin: { top: 567, right: 720, bottom: 567, left: 720 },
} as const;

// =============================================================================
// Money / dates / language helpers
// =============================================================================

export function minorFactor(currency: string): number {
  return currency === 'VND' ? 1 : 100;
}

export function formatMoney(minor: number, currency: string): string {
  const factor = minorFactor(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (factor === 1) return `${sign}${abs.toLocaleString('en-US')} ${currency}`;
  const major = Math.floor(abs / factor);
  const cents = abs % factor;
  return `${sign}${major.toLocaleString('en-US')}.${String(cents).padStart(2, '0')} ${currency}`;
}

export function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = d.getUTCFullYear();
  return `${dd}.${mm}.${yy}`;
}

export function bilingual(en: string | null, ru: string | null): string {
  const a = en?.trim() ?? '';
  const b = ru?.trim() ?? '';
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  return `${a} / ${b}`;
}

export function trilingual(en: string | null, ru: string | null, cn: string | null): string {
  return [en, ru, cn].filter((x) => x && x.trim()).join(' / ');
}

// =============================================================================
// Paragraph primitives
// =============================================================================

interface ParaOpts {
  bold?: boolean;
  italic?: boolean;
  size?: number;          // half-points (16 = 8pt, 18 = 9pt, 22 = 11pt)
  color?: string;
  align?: Alignment;
  spaceAfter?: number;    // default 0 — most lines stay tight
  spaceBefore?: number;
}

function makeParagraph(runs: TextRun[], opts: ParaOpts = {}): Paragraph {
  const para: Record<string, unknown> = { children: runs };
  if (opts.align !== undefined) para.alignment = opts.align;
  para.spacing = {
    before: opts.spaceBefore ?? 0,
    after: opts.spaceAfter ?? 0,
    line: 240,
  };
  return new Paragraph(para as never);
}

function makeRun(text: string, opts: ParaOpts = {}): TextRun {
  const r: Record<string, unknown> = { text, size: opts.size ?? 16 };
  if (opts.bold !== undefined) r.bold = opts.bold;
  if (opts.italic !== undefined) r.italics = opts.italic;
  if (opts.color !== undefined) r.color = opts.color;
  return new TextRun(r as never);
}

export function p(text: string, opts: ParaOpts = {}): Paragraph {
  return makeParagraph([makeRun(text, opts)], opts);
}

export function blank(): Paragraph {
  return makeParagraph([new TextRun('')], { size: 12, spaceAfter: 0 });
}

// =============================================================================
// Title + meta row
// =============================================================================

export function buildTitle(text: string): Paragraph {
  return p(text, { bold: true, size: 22, align: AlignmentType.CENTER, spaceAfter: 120 });
}

export interface MetaItem {
  label: string;
  value: string;
}

export function buildMetaRow(items: MetaItem[]): Paragraph {
  const runs: TextRun[] = [];
  items.forEach((item, i) => {
    if (i > 0) runs.push(makeRun('  ·  ', { size: 18, color: '707070' }));
    runs.push(makeRun(`${item.label}: `, { size: 18 }));
    runs.push(makeRun(item.value, { size: 18, bold: true }));
  });
  return makeParagraph(runs, { align: AlignmentType.CENTER, spaceAfter: 200 });
}

// =============================================================================
// Party blocks (used inside cells)
// =============================================================================

function partyContent(label: string, party: RenderParty, language: Language): Paragraph[] {
  const out: Paragraph[] = [];
  // Label: 9pt bold, small space after
  out.push(p(label, { bold: true, size: 18, spaceAfter: 60 }));

  // Names — bold primary line, lighter secondary
  if (language === 'BILINGUAL') {
    if (party.legalNameEn) out.push(p(party.legalNameEn, { bold: true, size: 16 }));
    if (party.legalNameLocal && party.legalNameLocal !== party.legalNameEn) {
      out.push(p(party.legalNameLocal, { size: 16 }));
    }
    if (party.legalNameCn) out.push(p(party.legalNameCn, { size: 16 }));
  } else if (language === 'RU') {
    out.push(p(party.legalNameLocal ?? party.legalNameEn ?? '', { bold: true, size: 16 }));
    if (party.legalNameEn && party.legalNameEn !== party.legalNameLocal) {
      out.push(p(party.legalNameEn, { italic: true, size: 14, color: '666666' }));
    }
  } else {
    out.push(p(party.legalNameEn ?? party.legalNameLocal ?? '', { bold: true, size: 16 }));
  }

  // Address
  const showLocalAddr = (language === 'RU' || language === 'BILINGUAL')
    && party.addressLocal && party.addressLocal !== party.addressEn;
  const primaryAddr = (language === 'RU')
    ? (party.addressLocal ?? party.addressEn)
    : (party.addressEn ?? party.addressLocal);
  if (primaryAddr) out.push(p(primaryAddr, { size: 16 }));
  if (language === 'BILINGUAL' && showLocalAddr && party.addressLocal) {
    out.push(p(party.addressLocal, { size: 16 }));
  }

  // Tax / registration IDs
  const idLine: string[] = [];
  if (party.inn) idLine.push(`ИНН ${party.inn}`);
  if (party.kpp) idLine.push(`КПП ${party.kpp}`);
  if (party.ogrn) idLine.push(`ОГРН ${party.ogrn}`);
  if (idLine.length === 0 && party.taxId) {
    idLine.push(language === 'RU' ? `ИНН ${party.taxId}` : `Tax ID ${party.taxId}`);
  }
  if (idLine.length === 0 && party.registrationNo) {
    idLine.push(language === 'RU' ? `Рег. № ${party.registrationNo}` : `Reg. No ${party.registrationNo}`);
  }
  if (idLine.length) out.push(p(idLine.join(', '), { size: 16 }));

  if (party.email) out.push(p(`Email: ${party.email}`, { size: 16 }));
  return out;
}

// =============================================================================
// Party table — 2 cells side-by-side, full page width.
// Left = Shipper (always) + optional Seller below when distinct.
// Right = Consignee (exactly once).
// =============================================================================

export interface PartyTableSpec {
  language: Language;
  totalWidthDxa: number;
  shipperLabel: string;
  shipper: RenderParty;
  consigneeLabel: string;
  consignee: RenderParty;
  sellerLabel?: string;
  seller?: RenderParty;
  sellerDistinct?: boolean;
}

export function buildPartyTable(spec: PartyTableSpec): Table {
  const half = Math.floor(spec.totalWidthDxa / 2);
  const leftChildren: Paragraph[] = [
    ...partyContent(spec.shipperLabel, spec.shipper, spec.language),
  ];
  if (spec.sellerDistinct && spec.seller && spec.sellerLabel) {
    leftChildren.push(blank());
    leftChildren.push(...partyContent(spec.sellerLabel, spec.seller, spec.language));
  }
  const rightChildren = partyContent(spec.consigneeLabel, spec.consignee, spec.language);

  return new Table({
    width: { size: spec.totalWidthDxa, type: WidthType.DXA },
    columnWidths: [half, spec.totalWidthDxa - half],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: half, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: CELL_MARGINS_PARTY,
            borders: NO_BORDERS,
            children: leftChildren,
          }),
          new TableCell({
            width: { size: spec.totalWidthDxa - half, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: CELL_MARGINS_PARTY,
            borders: NO_BORDERS,
            children: rightChildren,
          }),
        ],
      }),
    ],
  });
}

// =============================================================================
// Delivery + Bank table — 2 cells side-by-side, full page width.
// Either side may be empty (e.g. PL has no bank block on most flows).
// =============================================================================

export interface DeliveryBankTableSpec {
  language: Language;
  totalWidthDxa: number;
  deliveryHeader: string;
  deliveryLines: string[];
  // Right-side cell. EXACTLY ONE of `bank` or `rightLines` should be set
  // (with a header). When both are absent, the right cell renders empty.
  bankHeader?: string;
  bank?: RenderBank | null;
  rightHeader?: string;
  rightLines?: string[];
}

function bankContent(bank: RenderBank, language: Language): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(p(`${language === 'RU' ? 'Получатель' : 'Beneficiary'}: ${bank.accountHolder}`, { size: 16 }));
  out.push(p(bank.bankName, { size: 16 }));
  if (bank.bankAddress) out.push(p(bank.bankAddress, { size: 16 }));
  if (bank.accountNumber) {
    out.push(p(`${language === 'RU' ? 'Счёт' : 'Account'}: ${bank.accountNumber}`, { size: 16 }));
  }
  if (bank.iban) out.push(p(`IBAN: ${bank.iban}`, { size: 16 }));
  if (bank.swift) out.push(p(`SWIFT: ${bank.swift}`, { size: 16 }));
  if (bank.bik) out.push(p(`БИК: ${bank.bik}`, { size: 16 }));
  if (bank.correspondentAccount) {
    out.push(p(`${language === 'RU' ? 'Корр. счёт' : 'Correspondent account'}: ${bank.correspondentAccount}`, { size: 16 }));
  }
  out.push(p(`${language === 'RU' ? 'Валюта' : 'Currency'}: ${bank.currency}`, { size: 16 }));
  return out;
}

export function buildDeliveryBankTable(spec: DeliveryBankTableSpec): Table {
  const half = Math.floor(spec.totalWidthDxa / 2);
  const leftChildren: Paragraph[] = [
    p(spec.deliveryHeader, { bold: true, size: 18, spaceAfter: 60 }),
    ...spec.deliveryLines.map((line) => p(line, { size: 16 })),
  ];

  let rightChildren: Paragraph[];
  if (spec.bank && spec.bankHeader) {
    rightChildren = [
      p(spec.bankHeader, { bold: true, size: 18, spaceAfter: 60 }),
      ...bankContent(spec.bank, spec.language),
    ];
  } else if (spec.rightLines && spec.rightHeader) {
    rightChildren = [
      p(spec.rightHeader, { bold: true, size: 18, spaceAfter: 60 }),
      ...spec.rightLines.map((line) => p(line, { size: 16 })),
    ];
  } else {
    rightChildren = [p('', { size: 16 })];
  }

  return new Table({
    width: { size: spec.totalWidthDxa, type: WidthType.DXA },
    columnWidths: [half, spec.totalWidthDxa - half],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: half, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: CELL_MARGINS_PARTY,
            borders: NO_BORDERS,
            children: leftChildren,
          }),
          new TableCell({
            width: { size: spec.totalWidthDxa - half, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: CELL_MARGINS_PARTY,
            borders: NO_BORDERS,
            children: rightChildren,
          }),
        ],
      }),
    ],
  });
}

// =============================================================================
// Product table — full-width, hairline borders, shaded header + total row.
// =============================================================================

export type ColumnAlign = 'left' | 'center' | 'right';

function colAlignment(a: ColumnAlign | undefined): Alignment {
  if (a === 'right') return AlignmentType.RIGHT;
  if (a === 'left') return AlignmentType.LEFT;
  return AlignmentType.CENTER;
}

export interface ProductHeader {
  text: string;
  align?: ColumnAlign;
}

export interface ProductCell {
  text: string;
  align?: ColumnAlign;
  bold?: boolean;
}

export interface ProductTableSpec {
  totalWidthDxa: number;
  widths: number[];                   // sum should equal totalWidthDxa
  headers: ProductHeader[];           // length === widths.length
  rows: ProductCell[][];              // each row length === widths.length
  totalLabelSpan?: number;            // colspan for the TOTAL label cell
  totalLabel?: string;                // optional TOTAL row
  totalValues?: ProductCell[];        // values for the cells AFTER the merged label
}

function productCellChildren(cell: ProductCell, baseSize: number): Paragraph[] {
  const opts: ParaOpts = { size: baseSize, align: colAlignment(cell.align) };
  if (cell.bold !== undefined) opts.bold = cell.bold;
  return [p(cell.text ?? '', opts)];
}

export function buildProductTable(spec: ProductTableSpec): Table {
  const headerCells = spec.headers.map((h, i) => new TableCell({
    width: { size: spec.widths[i]!, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: CELL_MARGINS_TABLE,
    shading: { type: ShadingType.CLEAR, fill: SHADE_GRAY, color: 'auto' },
    children: [p(h.text, {
      bold: true, size: 18, align: colAlignment(h.align ?? 'center'),
    })],
  }));
  const headerRow = new TableRow({ tableHeader: true, children: headerCells });

  const bodyRows = spec.rows.map((row) => new TableRow({
    children: row.map((c, i) => new TableCell({
      width: { size: spec.widths[i]!, type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: CELL_MARGINS_TABLE,
      children: productCellChildren(c, 16),
    })),
  }));

  const trailingRows: TableRow[] = [];
  if (spec.totalLabel && spec.totalLabelSpan && spec.totalValues) {
    const labelCell = new TableCell({
      columnSpan: spec.totalLabelSpan,
      verticalAlign: VerticalAlign.CENTER,
      margins: CELL_MARGINS_TABLE,
      shading: { type: ShadingType.CLEAR, fill: SHADE_GRAY, color: 'auto' },
      children: [p(spec.totalLabel, {
        bold: true, size: 18, align: AlignmentType.RIGHT,
      })],
    });
    const valueCells = spec.totalValues.map((v, i) => {
      const widthIdx = spec.totalLabelSpan! + i;
      return new TableCell({
        width: { size: spec.widths[widthIdx]!, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
        margins: CELL_MARGINS_TABLE,
        shading: { type: ShadingType.CLEAR, fill: SHADE_GRAY, color: 'auto' },
        children: [p(v.text, {
          bold: true, size: 18, align: colAlignment(v.align ?? 'right'),
        })],
      });
    });
    trailingRows.push(new TableRow({ children: [labelCell, ...valueCells] }));
  }

  return new Table({
    width: { size: spec.totalWidthDxa, type: WidthType.DXA },
    columnWidths: spec.widths,
    layout: TableLayoutType.FIXED,
    borders: HAIRLINE_BORDERS,
    rows: [headerRow, ...bodyRows, ...trailingRows],
  });
}

// =============================================================================
// Signature line — right-aligned, compact.
// =============================================================================

export function buildSignature(sig: RenderSignature, language: Language): Paragraph[] {
  const titleEn = sig.titleEn ?? 'General Manager';
  const titleRu = sig.titleRu ?? 'Генеральный директор';
  const titleLine = language === 'RU'
    ? titleRu
    : (language === 'BILINGUAL' ? `${titleEn} / ${titleRu} / 盖章` : titleEn);
  const out: Paragraph[] = [];
  out.push(p('', { spaceAfter: 200 }));
  out.push(p('_______________________', { align: AlignmentType.RIGHT, size: 16 }));
  out.push(p(titleLine, { bold: true, size: 18, align: AlignmentType.RIGHT }));
  if (sig.name) out.push(p(sig.name, { size: 16, align: AlignmentType.RIGHT }));
  return out;
}

// =============================================================================
// Re-exports of base docx primitives some callers still reach for.
// =============================================================================

export { Document, Packer };
