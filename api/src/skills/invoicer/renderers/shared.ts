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
  HorizontalPositionAlign, HorizontalPositionRelativeFrom, ImageRun, LineRuleType, ShadingType, TextWrappingType,
  VerticalPositionRelativeFrom, Table, TableCell, TableLayoutType, TableRow, TextRun,
  VerticalAlign, WidthType,
} from 'docx';

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

// =============================================================================
// Public shapes
// =============================================================================

export type Language =
  | 'EN' | 'RU' | 'KA' | 'ZH' | 'VI' | 'AM' | 'UK'
  | 'DE' | 'TR' | 'UZ' | 'KK' | 'TH' | 'ID' | 'MS'
  | 'HI' | 'AR' | 'FR' | 'ES' | 'PT' | 'BILINGUAL';

// Re-export label dictionary so renderers can import { t } from './shared'.
export { t, tBilingual, hasTranslation, type RenderLanguage } from './i18n';


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
  // Issuer-owned stamp. Some scans already include the hand signature.
  stamp?: { data: Uint8Array; format: 'png' | 'jpg'; width: number; height: number } | null;
  // Separate authorised hand-signature scan when it is not part of stamp.
  handSignature?: { data: Uint8Array; format: 'png' | 'jpg'; width: number; height: number } | null;
  stampIncludesHandSignature?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const PORTRAIT_USABLE_DXA = 10500;
export const LANDSCAPE_USABLE_DXA = 15400;
const SHADE_GRAY = 'F2F2F2';
export const BRAND_ANTHRACITE = '1A1A1A';
export const BRAND_ROT = 'E5202C';
const SUBTLE_GRAY = '707070';
const BRAND_FONT = 'Calibri';  // safe sans-serif, available on all Office installs

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
  top: 40, bottom: 40, left: 120, right: 120,
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

// Unit prices keep up to three decimals (0.462 must not print as 0.46), never fewer than two.
export function formatUnitPrice(amount: number, currency: string): string {
  if (['VND', 'JPY', 'KRW'].includes(currency)) return formatMoney(amount, currency);
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${currency}`;
}

export function formatMoney(amount: number, currency: string): string {
  // amount is now a decimal major-unit value (e.g. 1234.56). VND/JPY/KRW
  // have no subdivision so we render with 0 fraction digits, others with 2.
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return `${amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} ${currency}`;
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
// pickLineLabel — single source of truth for "what text goes in the SKU column"
// of any invoicer-issued document. Replaces the ad-hoc per-renderer logic that
// used to fall through description_ru/_en chains.
//
// Selection rules (agreed with Aram):
//   - CI / PL  → partner language (RU/EN). NULL or unknown → fall back to EN.
//   - UPD / TN → always RU (Russian tax / transport docs).
//   - IS V1    → bilingual EN + RU, stacked with " / ".
//   - IS V2    → trilingual EN + RU + CN, stacked with " / ".
//
// For every leaf pick we go through invoice_label_{lang} → invoice_label_en →
// invoice_label (deprecated fallback) → item_description → product_id, so a
// missing translation never crashes the document — it gracefully degrades.
// =============================================================================

export interface LineLabelInput {
  invoice_label_ru: string | null;
  invoice_label_en: string | null;
  invoice_label_cn: string | null;
  invoice_label: string | null;
  item_description: string | null;
  product_id: string;
}

export type DocLabelContext =
  | { kind: 'CI' | 'PL'; partnerLang: 'RU' | 'EN' | null }
  | { kind: 'UPD' | 'TN' }
  | { kind: 'IS'; variant: 'V1' | 'V2' };

function fallbackChain(li: LineLabelInput, primary: string | null): string {
  return primary
    ?? li.invoice_label_en
    ?? li.invoice_label
    ?? li.item_description
    ?? li.product_id;
}

export function pickLineLabel(li: LineLabelInput, ctx: DocLabelContext): string {
  switch (ctx.kind) {
    case 'CI':
    case 'PL': {
      const lang = ctx.partnerLang ?? 'EN';
      const primary = lang === 'RU' ? li.invoice_label_ru : li.invoice_label_en;
      return fallbackChain(li, primary);
    }
    case 'UPD':
    case 'TN':
      return fallbackChain(li, li.invoice_label_ru);
    case 'IS':
      if (ctx.variant === 'V1') {
        return bilingual(li.invoice_label_en, li.invoice_label_ru)
          || fallbackChain(li, li.invoice_label_en);
      }
      // V2 — trilingual stacked label
      return trilingual(li.invoice_label_en, li.invoice_label_ru, li.invoice_label_cn)
        || fallbackChain(li, li.invoice_label_en);
  }
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
  lineSize?: number;      // largest run size in the paragraph when runs differ (half-points)
}

// Line height is EXACT at 1.2 x the text size. On "auto" the viewer takes the line height
// from the font's own metrics: Pages, which substitutes Calibri on macOS, opened every party
// and bank line at almost double height and pushed the IS onto a second page (Owner 06.10.2026).
// 1 half-point = 10 twips, so 1.2 x size = size * 12 twips.
function exactLine(halfPoints: number): number {
  return Math.round(halfPoints * 12);
}

function makeParagraph(runs: TextRun[], opts: ParaOpts = {}): Paragraph {
  // Every paragraph names the Normal style explicitly: docx does not mark our Normal as the
  // default style, and Pages only honours a style it is told about (see DOC_STYLES).
  const para: Record<string, unknown> = { children: runs, style: 'Normal' };
  if (opts.align !== undefined) para.alignment = opts.align;
  para.spacing = {
    before: opts.spaceBefore ?? 0,
    after: opts.spaceAfter ?? 0,
    line: exactLine(opts.lineSize ?? opts.size ?? 16),
    lineRule: LineRuleType.EXACT,
  };
  return new Paragraph(para as never);
}

function makeRun(text: string, opts: ParaOpts = {}): TextRun {
  const r: Record<string, unknown> = { text, size: opts.size ?? 16, font: BRAND_FONT };
  if (opts.bold !== undefined) r.bold = opts.bold;
  if (opts.italic !== undefined) r.italics = opts.italic;
  if (opts.color !== undefined) r.color = opts.color;
  return new TextRun(r as never);
}

// Base paragraph style for every invoicer document. Without a "Normal" style Pages falls back to
// its own 11 pt Helvetica body for each line: it ignored our spacing and right alignment, opened
// every cell line double-spaced and pushed the IS onto two pages (Owner 06.10.2026). Word and
// Quick Look were unaffected. Pass as `styles: DOC_STYLES` to `new Document`.
export const DOC_STYLES = {
  default: {
    document: {
      run: { font: 'Calibri', size: 16 },
      paragraph: { spacing: { before: 0, after: 0, line: 240 } },
    },
  },
  paragraphStyles: [{
    id: 'Normal',
    name: 'Normal',
    quickFormat: true,
    run: { font: 'Calibri', size: 16 },
    paragraph: { spacing: { before: 0, after: 0, line: 240 } },
  }],
};

export function p(text: string, opts: ParaOpts = {}): Paragraph {
  return makeParagraph([makeRun(text, opts)], opts);
}

export function blank(): Paragraph {
  return makeParagraph([new TextRun('')], { size: 12, spaceAfter: 0 });
}

// A block of lines inside one cell is ONE paragraph with line breaks, not one paragraph per line.
// Pages lays out every paragraph inside a table cell with its own body spacing and ignores the
// spacing we set, so separate paragraphs opened as double-spaced blocks and pushed the IS onto a
// second page (Owner 06.10.2026: «the lines could be more compact to fit everything on one page»).
export interface Line { text: string; opts?: ParaOpts }

export function lineBlock(lines: Line[]): Paragraph {
  const runs: TextRun[] = [];
  lines.forEach((l, i) => {
    if (i > 0) runs.push(new TextRun({ break: 1 }));
    runs.push(makeRun(l.text, { size: 16, ...l.opts }));
  });
  const maxSize = Math.max(16, ...lines.map((l) => l.opts?.size ?? 16));
  return makeParagraph(runs.length ? runs : [new TextRun('')], { size: maxSize });
}

// =============================================================================
// Title + meta row
// =============================================================================

export function buildTitle(text: string): Paragraph {
  // Large, bold, anthracite — sets a modern document tone without being noisy.
  return p(text.toUpperCase(), { bold: true, size: 36, color: BRAND_ANTHRACITE, align: AlignmentType.LEFT, spaceAfter: 60 });
}

export function buildBrandBar(): Paragraph {
  // Thin red accent rule under the title — Das Experten brand signature.
  return makeParagraph(
    [makeRun('▬▬▬▬▬▬▬▬▬▬▬▬▬', { size: 14, bold: true, color: BRAND_ROT })],
    { align: AlignmentType.LEFT, spaceAfter: 80, lineSize: 14 }
  );
}

export interface MetaItem {
  label: string;
  value: string;
}

export function buildMetaRow(items: MetaItem[]): Paragraph {
  const runs: TextRun[] = [];
  items.forEach((item, i) => {
    if (i > 0) runs.push(makeRun('     ', { size: 18 }));
    runs.push(makeRun(item.label.toUpperCase(), { size: 14, color: SUBTLE_GRAY, bold: true }));
    runs.push(makeRun('  ', { size: 14 }));
    runs.push(makeRun(item.value, { size: 18, bold: true, color: BRAND_ANTHRACITE }));
  });
  return makeParagraph(runs, { align: AlignmentType.LEFT, spaceAfter: 120, lineSize: 18 });
}

// =============================================================================
// Party blocks (used inside cells)
// =============================================================================

function partyContent(label: string, party: RenderParty, language: Language): Paragraph[] {
  const out: Line[] = [];
  // Label: 9pt bold, small space after
  const labelPara = p(label, { bold: true, size: 18, spaceAfter: 60 });

  // Names — bold primary line, lighter secondary
  if (language === 'BILINGUAL') {
    if (party.legalNameEn) out.push({ text: party.legalNameEn, opts: { bold: true, size: 16 } });
    if (party.legalNameLocal && party.legalNameLocal !== party.legalNameEn) {
      out.push({ text: party.legalNameLocal, opts: { size: 16 } });
    }
    if (party.legalNameCn) out.push({ text: party.legalNameCn, opts: { size: 16 } });
  } else if (language === 'RU') {
    out.push({ text: party.legalNameLocal ?? party.legalNameEn ?? '', opts: { bold: true, size: 16 } });
    if (party.legalNameEn && party.legalNameEn !== party.legalNameLocal) {
      out.push({ text: party.legalNameEn, opts: { italic: true, size: 14, color: '666666' } });
    }
  } else {
    out.push({ text: party.legalNameEn ?? party.legalNameLocal ?? '', opts: { bold: true, size: 16 } });
  }

  // Address
  const showLocalAddr = (language === 'RU' || language === 'BILINGUAL')
    && party.addressLocal && party.addressLocal !== party.addressEn;
  const primaryAddr = (language === 'RU')
    ? (party.addressLocal ?? party.addressEn)
    : (party.addressEn ?? party.addressLocal);
  if (primaryAddr) out.push({ text: primaryAddr, opts: { size: 16 } });
  if (language === 'BILINGUAL' && showLocalAddr && party.addressLocal) {
    out.push({ text: party.addressLocal, opts: { size: 16 } });
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
  if (idLine.length) out.push({ text: idLine.join(', '), opts: { size: 16 } });

  if (party.email) out.push({ text: `Email: ${party.email}`, opts: { size: 16 } });
  return [labelPara, lineBlock(out)];
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
// Full-width party line — used when the physical shipper is distinct from the
// seller but the operation currently stores the shipper as one verified legal
// name/address line. Its hierarchy deliberately matches SELLER / BUYER blocks:
// a 9 pt bold label followed by 8 pt body copy.
// =============================================================================

export interface PartyLineBlockSpec {
  totalWidthDxa: number;
  label: string;
  lines: string[];
}

export function buildPartyLineBlock(spec: PartyLineBlockSpec): Table {
  return new Table({
    width: { size: spec.totalWidthDxa, type: WidthType.DXA },
    columnWidths: [spec.totalWidthDxa],
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: spec.totalWidthDxa, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            margins: CELL_MARGINS_PARTY,
            borders: NO_BORDERS,
            children: [
              p(spec.label, { bold: true, size: 18, spaceAfter: 60 }),
              lineBlock(spec.lines.map((text) => ({ text }))),
            ],
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

function bankContent(bank: RenderBank, language: Language): Line[] {
  const out: Line[] = [];
  out.push({ text: `${language === 'RU' ? 'Получатель' : 'Beneficiary'}: ${bank.accountHolder}` });
  out.push({ text: bank.bankName });
  if (bank.bankAddress) out.push({ text: bank.bankAddress });
  if (bank.accountNumber) {
    out.push({ text: `${language === 'RU' ? 'Счёт' : 'Account'}: ${bank.accountNumber}` });
  }
  if (bank.iban) out.push({ text: `IBAN: ${bank.iban}` });
  if (bank.swift) out.push({ text: `SWIFT: ${bank.swift}` });
  if (bank.bik) out.push({ text: `БИК: ${bank.bik}` });
  if (bank.correspondentAccount) {
    out.push({ text: `${language === 'RU' ? 'Корр. счёт' : 'Correspondent account'}: ${bank.correspondentAccount}` });
  }
  out.push({ text: `${language === 'RU' ? 'Валюта' : 'Currency'}: ${bank.currency}` });
  return out;
}

export function buildDeliveryBankTable(spec: DeliveryBankTableSpec): Table {
  const half = Math.floor(spec.totalWidthDxa / 2);
  const leftChildren: Paragraph[] = [
    p(spec.deliveryHeader, { bold: true, size: 18, spaceAfter: 60 }),
    lineBlock(spec.deliveryLines.map((text) => ({ text }))),
  ];

  let rightChildren: Paragraph[];
  if (spec.bank && spec.bankHeader) {
    rightChildren = [
      p(spec.bankHeader, { bold: true, size: 18, spaceAfter: 60 }),
      lineBlock(bankContent(spec.bank, spec.language)),
    ];
  } else if (spec.rightLines && spec.rightHeader) {
    rightChildren = [
      p(spec.rightHeader, { bold: true, size: 18, spaceAfter: 60 }),
      lineBlock(spec.rightLines.map((text) => ({ text }))),
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

  // Signature block at the right end of the page: hand signature, then title and name, and the
  // stamp floats OVER that text the way a real stamp is pressed onto a signed page (Owner
  // 06.10.2026: «as if it is stamped on the text», «just as a normal stamp size and the name
  // size»). Plain paragraphs, not a table: Pages drops images that float inside a table cell.
  // Sizes are px at 96 dpi: 132 px = 3.5 cm stamp circle, 150 px = 4 cm signature. Only the
  // combined DEI scan (signature baked into the stamp) keeps the larger width the Owner asked
  // for on 16.09 and stays inline.
  const CM = 360000; // EMU per cm
  const scaled = (s: NonNullable<RenderSignature['stamp']>, w: number) => (
    { width: w, height: Math.round(s.height * w / s.width) }
  );
  const out: Paragraph[] = [];

  const firstLine: ImageRun[] = [];
  if (sig.handSignature) {
    firstLine.push(new ImageRun({
      type: sig.handSignature.format,
      data: sig.handSignature.data,
      transformation: scaled(sig.handSignature, 150),
    }));
  }
  if (sig.stamp && sig.stampIncludesHandSignature) {
    firstLine.push(new ImageRun({
      type: sig.stamp.format,
      data: sig.stamp.data,
      transformation: scaled(sig.stamp, 600),
    }));
  }
  if (firstLine.length) {
    out.push(new Paragraph({ style: 'Normal', alignment: AlignmentType.RIGHT, children: firstLine }));
  } else if (!sig.stamp) {
    out.push(p('_______________________', { align: AlignmentType.RIGHT, size: 16 }));
  }

  const titleRuns: (ImageRun | TextRun)[] = [];
  if (sig.stamp && !sig.stampIncludesHandSignature) {
    titleRuns.push(new ImageRun({
      type: sig.stamp.format,
      data: sig.stamp.data,
      transformation: scaled(sig.stamp, 132),
      floating: {
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, align: HorizontalPositionAlign.RIGHT },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: Math.round(-2.0 * CM) },
        wrap: { type: TextWrappingType.NONE },
        allowOverlap: true,
        behindDocument: false,
        zIndex: 10,
      },
    }));
  }
  titleRuns.push(makeRun(titleLine, { bold: true, size: 18 }));
  out.push(new Paragraph({ style: 'Normal', alignment: AlignmentType.RIGHT, children: titleRuns }));
  if (sig.name) out.push(p(sig.name, { size: 16, align: AlignmentType.RIGHT }));
  return out;
}

// =============================================================================
// Re-exports of base docx primitives some callers still reach for.
// =============================================================================

export { Document, Packer };
