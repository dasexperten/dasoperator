// =============================================================================
// Renderer helpers shared by CI / PL / IS-V1 / IS-V2.
// All functions are pure docx-primitive builders.
// =============================================================================
//
// The renderers use a small set of generic shapes (RenderParty / RenderBank /
// RenderSignature) so the same code path handles "company as seller",
// "manufacturer as seller", and "partner as buyer". The entry point builds
// these shapes from CompanyRow / ManufacturerRow / PartnerRow.
// =============================================================================

import {
  AlignmentType, BorderStyle, HeightRule, Paragraph, Table, TableCell, TableRow,
  TextRun, VerticalAlign, WidthType,
} from 'docx';

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

// ---- Public shapes ----------------------------------------------------------

export interface RenderParty {
  legalNameEn: string | null;
  legalNameLocal: string | null;   // RU for buyers/companies, RU/CN for manufacturers
  legalNameCn: string | null;
  addressEn: string | null;
  addressLocal: string | null;
  taxId: string | null;            // ИНН / USCC / Tax ID — print as-is
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

// ---- Money / dates ----------------------------------------------------------

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

// ---- Bilingual / trilingual concatenation -----------------------------------

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

// ---- Paragraph / TextRun shorthands -----------------------------------------

export interface TextOpts {
  bold?: boolean;
  size?: number;       // half-points (24 = 12pt)
  italic?: boolean;
  color?: string;
}

export function p(text: string, opts: TextOpts = {}, alignment?: Alignment): Paragraph {
  const runOpts: Record<string, unknown> = { text, size: opts.size ?? 20 };
  if (opts.bold !== undefined) runOpts.bold = opts.bold;
  if (opts.italic !== undefined) runOpts.italics = opts.italic;
  if (opts.color !== undefined) runOpts.color = opts.color;

  const paraOpts: Record<string, unknown> = { children: [new TextRun(runOpts as never)] };
  if (alignment !== undefined) paraOpts.alignment = alignment;
  return new Paragraph(paraOpts as never);
}

export function blank(): Paragraph {
  return new Paragraph({ children: [new TextRun('')] });
}

export function heading(text: string): Paragraph {
  return p(text, { bold: true, size: 32 }, AlignmentType.CENTER);
}

export function subheading(text: string): Paragraph {
  return p(text, { bold: true, size: 22 });
}

// ---- Table builder ----------------------------------------------------------

const THIN = { style: BorderStyle.SINGLE, size: 4, color: '888888' };

export interface TableColumn {
  header: string;
  widthPct: number;
}

export function buildTable(columns: TableColumn[], rows: string[][]): Table {
  const header = new TableRow({
    tableHeader: true,
    height: { value: 360, rule: HeightRule.ATLEAST },
    children: columns.map((c) => new TableCell({
      width: { size: c.widthPct, type: WidthType.PERCENTAGE },
      children: [p(c.header, { bold: true, size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  });

  const bodyRows = rows.map((row) => new TableRow({
    children: row.map((value, colIdx) => new TableCell({
      width: { size: columns[colIdx]!.widthPct, type: WidthType.PERCENTAGE },
      children: [p(value ?? '', { size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [header, ...bodyRows],
  });
}

// =============================================================================
// buildTableDxa — fixed-width table with explicit DXA column widths.
// Used by the IS renderers (landscape page) where Description deserves the
// most real estate and percentage-based sizing collapses it on Word's auto
// layout. DXA = twentieths of a point (1 inch = 1440 DXA).
// =============================================================================

export interface TableColumnDxa {
  header: string;
  widthDxa: number;
}

export function buildTableDxa(columns: TableColumnDxa[], rows: string[][]): Table {
  const widths = columns.map((c) => c.widthDxa);

  const header = new TableRow({
    tableHeader: true,
    height: { value: 360, rule: HeightRule.ATLEAST },
    children: columns.map((c) => new TableCell({
      width: { size: c.widthDxa, type: WidthType.DXA },
      children: [p(c.header, { bold: true, size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  });

  const bodyRows = rows.map((row) => new TableRow({
    children: row.map((value, colIdx) => new TableCell({
      width: { size: columns[colIdx]!.widthDxa, type: WidthType.DXA },
      children: [p(value ?? '', { size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  }));

  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows: [header, ...bodyRows],
  });
}

// ---- Party / bank / signature blocks ----------------------------------------

export interface PartyBlockOpts {
  /** Language scope: 'EN' = English-only, 'RU' = Russian primary,
   *  'BILINGUAL' = both. Used to choose name + address rendering order. */
  language: 'EN' | 'RU' | 'BILINGUAL';
  label: string;
  party: RenderParty;
}

export function partyBlock(opts: PartyBlockOpts): Paragraph[] {
  const { language, label, party } = opts;
  const out: Paragraph[] = [subheading(label)];

  const ru = party.legalNameLocal;
  const en = party.legalNameEn;
  const cn = party.legalNameCn;

  if (language === 'BILINGUAL') {
    if (en) out.push(p(en, { bold: true, size: 18 }));
    if (ru) out.push(p(ru, { size: 18 }));
    if (cn) out.push(p(cn, { size: 18 }));
  } else if (language === 'RU') {
    out.push(p(ru ?? en ?? '', { bold: true, size: 18 }));
    if (en && en !== ru) out.push(p(en, { italic: true, size: 16 }));
  } else {
    out.push(p(en ?? ru ?? '', { bold: true, size: 18 }));
  }

  if (party.addressEn || party.addressLocal) {
    if (language === 'BILINGUAL') {
      if (party.addressEn) out.push(p(party.addressEn, { size: 18 }));
      if (party.addressLocal && party.addressLocal !== party.addressEn) {
        out.push(p(party.addressLocal, { size: 18 }));
      }
    } else if (language === 'RU') {
      out.push(p(party.addressLocal ?? party.addressEn ?? '', { size: 18 }));
    } else {
      out.push(p(party.addressEn ?? party.addressLocal ?? '', { size: 18 }));
    }
  }

  // Tax IDs (mostly relevant for RU/BILINGUAL; English-only docs still carry tax_id).
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
  if (idLine.length) out.push(p(idLine.join(', '), { size: 18 }));

  if (party.email) out.push(p(`Email: ${party.email}`, { size: 18 }));
  return out;
}

// =============================================================================
// partyTable — horizontal 2-column layout for IS variants.
// Left  = Shipper (always) + optional Seller block underneath when distinct
//         from Shipper.
// Right = Consignee (always exactly once — no duplication).
//
// Used by IS-V1 (Brushes) and IS-V2 (Toothpastes) on landscape A4. Column
// widths are 50/50 of the 15400 DXA usable area (7700 each). Cells are
// top-aligned and borderless to keep the look clean.
// =============================================================================

export interface PartyTableInput {
  language: 'EN' | 'RU' | 'BILINGUAL';
  shipperLabel: string;
  shipper: RenderParty;
  consigneeLabel: string;
  consignee: RenderParty;
  // Optional second block placed in the LEFT column underneath Shipper.
  // Only rendered when sellerDistinct === true. Caller decides distinctness
  // (the renderer has no access to row IDs).
  sellerLabel?: string;
  seller?: RenderParty;
  sellerDistinct?: boolean;
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

export function partyTable(input: PartyTableInput): Table {
  const {
    language, shipperLabel, shipper, consigneeLabel, consignee,
    sellerLabel, seller, sellerDistinct,
  } = input;

  const leftChildren: Paragraph[] = [
    ...partyBlock({ language, label: shipperLabel, party: shipper }),
  ];
  if (sellerDistinct && seller && sellerLabel) {
    leftChildren.push(blank());
    leftChildren.push(...partyBlock({ language, label: sellerLabel, party: seller }));
  }

  const rightChildren = partyBlock({ language, label: consigneeLabel, party: consignee });

  return new Table({
    width: { size: 15400, type: WidthType.DXA },
    columnWidths: [7700, 7700],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 7700, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            children: leftChildren,
          }),
          new TableCell({
            width: { size: 7700, type: WidthType.DXA },
            verticalAlign: VerticalAlign.TOP,
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            children: rightChildren,
          }),
        ],
      }),
    ],
  });
}

export function bankBlock(
  bank: RenderBank, language: 'EN' | 'RU' | 'BILINGUAL', label?: string
): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(subheading(label ?? (language === 'RU' ? 'Банковские реквизиты' : 'Bank details')));
  out.push(p(`${language === 'RU' ? 'Получатель' : 'Beneficiary'}: ${bank.accountHolder}`, { size: 18 }));
  out.push(p(bank.bankName, { size: 18 }));
  if (bank.bankAddress) out.push(p(bank.bankAddress, { size: 18 }));
  if (bank.accountNumber) out.push(p(`${language === 'RU' ? 'Счёт' : 'Account'}: ${bank.accountNumber}`, { size: 18 }));
  if (bank.iban) out.push(p(`IBAN: ${bank.iban}`, { size: 18 }));
  if (bank.swift) out.push(p(`SWIFT: ${bank.swift}`, { size: 18 }));
  if (bank.bik) out.push(p(`БИК: ${bank.bik}`, { size: 18 }));
  if (bank.correspondentAccount) {
    out.push(p(`${language === 'RU' ? 'Корр. счёт' : 'Correspondent account'}: ${bank.correspondentAccount}`, { size: 18 }));
  }
  out.push(p(`${language === 'RU' ? 'Валюта' : 'Currency'}: ${bank.currency}`, { size: 18 }));
  return out;
}

export function signatureBlock(
  sig: RenderSignature, language: 'EN' | 'RU' | 'BILINGUAL'
): Paragraph[] {
  const title = language === 'RU'
    ? (sig.titleRu ?? 'Генеральный директор')
    : (sig.titleEn ?? 'General Manager');
  return [
    blank(), blank(),
    p('_______________________'),
    p(`${title}${sig.name ? `: ${sig.name}` : ''}`, { size: 18 }),
  ];
}
