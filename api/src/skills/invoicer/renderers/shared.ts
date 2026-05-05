// =============================================================================
// Renderer helpers shared by CI / PL / IS-V1 / IS-V2.
// All functions return docx primitives — keep them pure and side-effect-free.
// =============================================================================

import {
  AlignmentType, BorderStyle, HeightRule, Paragraph, Table, TableCell, TableRow,
  TextRun, WidthType,
} from 'docx';
import type { CompanyRow, DocumentLanguage, PartnerRow } from '../types';

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

// ---- Money / dates -----------------------------------------------------------

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

export function formatDate(unixSec: number, language: DocumentLanguage): string {
  const d = new Date(unixSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = d.getUTCFullYear();
  // Russian businesses expect DD.MM.YYYY; international can take either —
  // standardise on DD.MM.YYYY for both so the parser side has one format.
  void language;
  return `${dd}.${mm}.${yy}`;
}

// ---- Bilingual text ----------------------------------------------------------

export function bilingual(en: string, ru: string): string {
  if (!en && !ru) return '';
  if (!en) return ru;
  if (!ru) return en;
  return `${en} / ${ru}`;
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

// ---- Table builders ---------------------------------------------------------

const THIN = { style: BorderStyle.SINGLE, size: 4, color: '888888' };

export interface TableColumn {
  header: string;
  widthPct: number;       // percentage of total table width; should sum to ~100
}

export function buildTable(
  columns: TableColumn[],
  rows: string[][],
  opts: { headerBold?: boolean } = {}
): Table {
  const header = new TableRow({
    tableHeader: true,
    height: { value: 360, rule: HeightRule.ATLEAST },
    children: columns.map((c) => new TableCell({
      width: { size: c.widthPct, type: WidthType.PERCENTAGE },
      children: [p(c.header, { bold: opts.headerBold !== false, size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  });

  const bodyRows = rows.map((row) => new TableRow({
    children: row.map((value, colIdx) => new TableCell({
      width: { size: columns[colIdx]!.widthPct, type: WidthType.PERCENTAGE },
      children: [p(value, { size: 18 })],
      borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [header, ...bodyRows],
  });
}

// ---- Party blocks -----------------------------------------------------------

export function sellerBlock(
  ourCompany: CompanyRow, language: DocumentLanguage,
  bank: import('../types').BankAccountSelection | null,
  labelOverride?: string
): Paragraph[] {
  const label = labelOverride ?? (language === 'RU' ? 'ПРОДАВЕЦ' : 'SELLER');
  const name = (language === 'RU' && ourCompany.legal_name_ru)
    ? ourCompany.legal_name_ru
    : ourCompany.legal_name;

  const out: Paragraph[] = [subheading(label), p(name, { bold: true })];

  if (ourCompany.registered_address) {
    out.push(p(ourCompany.registered_address));
  }
  const taxLine: string[] = [];
  if (ourCompany.tax_id) taxLine.push(language === 'RU' ? `ИНН ${ourCompany.tax_id}` : `Tax ID ${ourCompany.tax_id}`);
  if (ourCompany.kpp) taxLine.push(`КПП ${ourCompany.kpp}`);
  if (ourCompany.ogrn) taxLine.push(`ОГРН ${ourCompany.ogrn}`);
  if (ourCompany.registration_no && taxLine.length === 0) {
    taxLine.push(language === 'RU' ? `Рег. № ${ourCompany.registration_no}` : `Reg. No ${ourCompany.registration_no}`);
  }
  if (taxLine.length) out.push(p(taxLine.join(', ')));

  if (bank) {
    out.push(blank());
    out.push(p(language === 'RU' ? 'Банковские реквизиты:' : 'Bank details:', { bold: true, size: 18 }));
    if (bank.bank_name) out.push(p(bank.bank_name, { size: 18 }));
    if (bank.bank_address) out.push(p(bank.bank_address, { size: 18 }));
    out.push(p(`${language === 'RU' ? 'Счёт' : 'Account'}: ${bank.account_number}`, { size: 18 }));
    if (bank.bik) out.push(p(`БИК: ${bank.bik}`, { size: 18 }));
    if (bank.correspondent_account) {
      out.push(p(`${language === 'RU' ? 'Корр. счёт' : 'Correspondent account'}: ${bank.correspondent_account}`, { size: 18 }));
    }
    if (bank.swift) out.push(p(`SWIFT: ${bank.swift}`, { size: 18 }));
    if (bank.iban) out.push(p(`IBAN: ${bank.iban}`, { size: 18 }));
  }
  return out;
}

export function buyerBlock(
  partner: PartnerRow, language: DocumentLanguage, labelOverride?: string
): Paragraph[] {
  const label = labelOverride ?? (language === 'RU' ? 'ПОКУПАТЕЛЬ' : 'BUYER');
  const name = (language === 'RU' && partner.legal_name_local)
    ? partner.legal_name_local
    : (partner.legal_name ?? partner.trade_name);

  const out: Paragraph[] = [subheading(label), p(name, { bold: true })];

  const address = partner.registered_address_local ?? partner.country;
  if (address) out.push(p(address));

  const taxLine: string[] = [];
  if (partner.inn) taxLine.push(`ИНН ${partner.inn}`);
  if (partner.kpp) taxLine.push(`КПП ${partner.kpp}`);
  if (partner.ogrn) taxLine.push(`ОГРН ${partner.ogrn}`);
  if (taxLine.length === 0 && partner.tax_id) {
    taxLine.push(language === 'RU' ? `ИНН ${partner.tax_id}` : `Tax ID ${partner.tax_id}`);
  }
  if (taxLine.length) out.push(p(taxLine.join(', ')));

  if (partner.email) out.push(p(`${language === 'RU' ? 'Эл. почта' : 'Email'}: ${partner.email}`, { size: 18 }));
  return out;
}

// ---- Signature block --------------------------------------------------------

export function signatureBlock(
  ourCompany: CompanyRow, language: DocumentLanguage
): Paragraph[] {
  const title = language === 'RU'
    ? (ourCompany.signing_authority_title_ru ?? 'Генеральный директор')
    : (ourCompany.signing_authority_title_en ?? 'General Manager');
  const name = ourCompany.signing_authority_name ?? '';

  return [
    blank(), blank(),
    p('_______________________'),
    p(`${title}${name ? `: ${name}` : ''}`, { size: 18 }),
  ];
}
