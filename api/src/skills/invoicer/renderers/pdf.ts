import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument, PDFPage, PDFFont, PDFImage, rgb,
} from 'pdf-lib';
import type { LineItemRow } from '../types';
import type { RenderCiInput } from './ci';
import type { RenderIsV1Input } from './is-variant1';
import type { RenderIsV2Input } from './is-variant2';
import type { RenderPlInput } from './pl';
import type { RenderTnInput } from './tn';
import type { RenderUpdInput } from './upd';
import {
  formatDate, formatMoney, formatUnitPrice, pickLineLabel,
  type RenderBank, type RenderParty, type RenderSignature,
} from './shared';
import { pdfFontBytes } from './pdf-fonts';

type PdfKind = 'CI' | 'PL' | 'IS-V1' | 'IS-V2' | 'UPD' | 'TN';

interface PdfPartyBlock {
  label: string;
  party: RenderParty;
}

interface PdfModel {
  kind: PdfKind;
  title: string;
  reference: string;
  issuedAt: number;
  language: string;
  currency: string | null;
  parties: PdfPartyBlock[];
  highlightedParties?: Array<{ label: string; lines: string[] }>;
  details: string[];
  bank: RenderBank | null;
  lineItems: LineItemRow[];
  total: number | null;
  extraCharges: Array<{ label: string; amount: number }>;
  signature: RenderSignature;
  vatRatePct?: number;
}

interface FontSet {
  latin: PDFFont;
  cyrillic: PDFFont;
  vietnamese: PDFFont;
}

interface TableColumn {
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 32;
const TEXT = rgb(0.10, 0.10, 0.10);
const MUTED = rgb(0.38, 0.38, 0.38);
const LINE = rgb(0.72, 0.72, 0.72);
const SHADE = rgb(0.95, 0.95, 0.95);
const BRAND = rgb(0.83, 0.04, 0.08);

function isRussian(language: string, kind: PdfKind): boolean {
  return language === 'RU' || kind === 'UPD' || kind === 'TN';
}

function partyName(p: RenderParty, ru: boolean): string {
  return (ru ? p.legalNameLocal : p.legalNameEn)
    ?? p.legalNameEn ?? p.legalNameLocal ?? '';
}

function partyLines(p: RenderParty, ru: boolean): string[] {
  const lines = [partyName(p, ru)];
  const address = (ru ? p.addressLocal : p.addressEn) ?? p.addressEn ?? p.addressLocal;
  if (address) lines.push(address);
  const ids: string[] = [];
  if (p.inn) ids.push(`INN ${p.inn}`);
  else if (p.taxId) ids.push(`Tax ID ${p.taxId}`);
  if (p.kpp) ids.push(`KPP ${p.kpp}`);
  if (p.ogrn) ids.push(`OGRN ${p.ogrn}`);
  if (p.registrationNo) ids.push(`Reg. No. ${p.registrationNo}`);
  if (ids.length > 0) lines.push(ids.join(' · '));
  if (p.email) lines.push(p.email);
  return lines.filter(Boolean);
}

function bankLines(bank: RenderBank | null): string[] {
  if (!bank) return [];
  const lines = [bank.bankName];
  if (bank.accountHolder) lines.push(`Account holder: ${bank.accountHolder}`);
  if (bank.accountNumber) lines.push(`Account: ${bank.accountNumber}`);
  if (bank.iban) lines.push(`IBAN: ${bank.iban}`);
  if (bank.swift) lines.push(`SWIFT: ${bank.swift}`);
  if (bank.bik) lines.push(`BIK: ${bank.bik}`);
  if (bank.correspondentAccount) lines.push(`Corr. account: ${bank.correspondentAccount}`);
  if (bank.bankAddress) lines.push(bank.bankAddress);
  return lines;
}

function hasVietnamese(text: string): boolean {
  return /[ĂÂĐÊÔƠƯăâđêôơưÀ-ỹ]/u.test(text);
}

function chooseFont(fonts: FontSet, text: string): PDFFont {
  if (/\p{Script=Cyrillic}/u.test(text)) return fonts.cyrillic;
  if (hasVietnamese(text)) return fonts.vietnamese;
  return fonts.latin;
}

function sanitize(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  return Array.from(text).map((char) => supported.has(char.codePointAt(0) ?? 0) ? char : '?').join('');
}

function widthOf(fonts: FontSet, text: string, size: number): number {
  const font = chooseFont(fonts, text);
  return font.widthOfTextAtSize(sanitize(font, text), size);
}

function wrap(fonts: FontSet, text: string, size: number, maxWidth: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(fonts, candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (widthOf(fonts, word, size) <= maxWidth) {
      line = word;
      continue;
    }
    let part = '';
    for (const char of Array.from(word)) {
      if (part && widthOf(fonts, part + char, size) > maxWidth) {
        lines.push(part);
        part = char;
      } else {
        part += char;
      }
    }
    line = part;
  }
  if (line) lines.push(line);
  return lines;
}

class PdfCanvas {
  readonly doc: PDFDocument;
  readonly fonts: FontSet;
  readonly landscape: boolean;
  page: PDFPage;
  y: number;
  pageNo = 0;

  constructor(doc: PDFDocument, fonts: FontSet, landscape: boolean) {
    this.doc = doc;
    this.fonts = fonts;
    this.landscape = landscape;
    this.page = this.newPage();
    this.y = this.page.getHeight() - MARGIN;
  }

  newPage(): PDFPage {
    this.pageNo += 1;
    const page = this.doc.addPage(this.landscape ? A4_LANDSCAPE : A4_PORTRAIT);
    page.drawText(String(this.pageNo), {
      x: page.getWidth() - MARGIN - 8, y: 15,
      size: 7, font: this.fonts.latin, color: MUTED,
    });
    return page;
  }

  ensure(height: number, continued?: () => void): void {
    if (this.y - height >= MARGIN + 14) return;
    this.page = this.newPage();
    this.y = this.page.getHeight() - MARGIN;
    continued?.();
  }

  drawText(text: string, x: number, y: number, size = 9, options: {
    color?: ReturnType<typeof rgb>; bold?: boolean; maxWidth?: number;
    align?: 'left' | 'right' | 'center';
  } = {}): void {
    const font = chooseFont(this.fonts, text);
    const safe = sanitize(font, text);
    let drawX = x;
    const textWidth = font.widthOfTextAtSize(safe, size);
    if (options.align === 'right' && options.maxWidth) drawX += options.maxWidth - textWidth;
    if (options.align === 'center' && options.maxWidth) drawX += (options.maxWidth - textWidth) / 2;
    this.page.drawText(safe, { x: drawX, y, size, font, color: options.color ?? TEXT });
    if (options.bold) {
      this.page.drawText(safe, { x: drawX + 0.18, y, size, font, color: options.color ?? TEXT });
    }
  }

  paragraph(text: string, options: {
    x?: number; width?: number; size?: number; leading?: number; bold?: boolean;
    color?: ReturnType<typeof rgb>; gapAfter?: number;
  } = {}): number {
    const x = options.x ?? MARGIN;
    const width = options.width ?? this.page.getWidth() - MARGIN * 2;
    const size = options.size ?? 9;
    const leading = options.leading ?? size * 1.28;
    const lines = wrap(this.fonts, text, size, width);
    const height = lines.length * leading;
    this.ensure(height + (options.gapAfter ?? 0));
    for (const line of lines) {
      this.y -= leading;
      this.drawText(line, x, this.y, size, {
        ...(options.bold === undefined ? {} : { bold: options.bold }),
        ...(options.color === undefined ? {} : { color: options.color }),
      });
    }
    this.y -= options.gapAfter ?? 0;
    return height;
  }
}

function drawHeader(c: PdfCanvas, model: PdfModel, continued = false): void {
  const width = c.page.getWidth() - MARGIN * 2;
  c.drawText(continued ? `${model.title} · CONTINUED` : model.title,
    MARGIN, c.y - 21, continued ? 14 : 18, { bold: true });
  c.drawText('DAS EXPERTEN', MARGIN, c.y - 37, 8, { color: BRAND, bold: true });
  c.page.drawLine({ start: { x: MARGIN, y: c.y - 44 }, end: { x: MARGIN + width, y: c.y - 44 }, thickness: 1.3, color: BRAND });
  c.y -= 55;
  if (!continued) {
    c.drawText(`No. ${model.reference}`, MARGIN, c.y - 10, 9, { bold: true });
    c.drawText(`Date ${formatDate(model.issuedAt)}`, MARGIN + width / 2, c.y - 10, 9, { bold: true });
    c.y -= 25;
  }
}

function drawPartyGrid(c: PdfCanvas, model: PdfModel): void {
  const gap = 8;
  const totalWidth = c.page.getWidth() - MARGIN * 2;
  const cols = Math.min(model.parties.length, model.parties.length === 3 ? 3 : 2);
  const colWidth = (totalWidth - gap * (cols - 1)) / cols;
  const ru = isRussian(model.language, model.kind);
  const wrapped = model.parties.map((block) => {
    const lines = partyLines(block.party, ru).flatMap((line) => wrap(c.fonts, line, 8, colWidth - 14));
    return { ...block, lines };
  });
  const maxLines = Math.max(...wrapped.map((b) => b.lines.length));
  const height = 28 + maxLines * 10;
  c.ensure(height + 8, () => drawHeader(c, model, true));
  wrapped.forEach((block, i) => {
    const x = MARGIN + i * (colWidth + gap);
    c.page.drawRectangle({ x, y: c.y - height, width: colWidth, height, borderColor: LINE, borderWidth: 0.7 });
    c.page.drawRectangle({ x, y: c.y - 18, width: colWidth, height: 18, color: SHADE });
    c.drawText(block.label, x + 7, c.y - 12, 7.5, { bold: true, color: MUTED });
    let lineY = c.y - 29;
    for (const line of block.lines) {
      c.drawText(line, x + 7, lineY, 8, { bold: lineY === c.y - 29 });
      lineY -= 10;
    }
  });
  c.y -= height + 9;
}

function drawHighlightedParties(c: PdfCanvas, model: PdfModel): void {
  const blocks = model.highlightedParties ?? [];
  if (blocks.length === 0) return;
  const width = c.page.getWidth() - MARGIN * 2;
  for (const block of blocks) {
    const lines = block.lines.flatMap((line) => wrap(c.fonts, line, 8, width - 14));
    const height = 28 + Math.max(1, lines.length) * 10;
    c.ensure(height + 9, () => drawHeader(c, model, true));
    c.page.drawRectangle({ x: MARGIN, y: c.y - height, width, height, borderColor: LINE, borderWidth: 0.7 });
    c.page.drawRectangle({ x: MARGIN, y: c.y - 18, width, height: 18, color: SHADE });
    c.drawText(block.label, MARGIN + 7, c.y - 12, 7.5, { bold: true, color: MUTED });
    let lineY = c.y - 29;
    for (const line of lines) {
      c.drawText(line, MARGIN + 7, lineY, 8);
      lineY -= 10;
    }
    c.y -= height + 9;
  }
}

function drawInfo(c: PdfCanvas, model: PdfModel): void {
  const bank = bankLines(model.bank);
  const blocks: Array<{ label: string; lines: string[] }> = [];
  if (model.details.length > 0) blocks.push({ label: 'DELIVERY / DETAILS', lines: model.details });
  if (bank.length > 0) blocks.push({ label: 'BANK DETAILS', lines: bank });
  if (blocks.length === 0) return;
  const gap = 8;
  const totalWidth = c.page.getWidth() - MARGIN * 2;
  const colWidth = (totalWidth - gap * (blocks.length - 1)) / blocks.length;
  const wrapped = blocks.map((b) => ({
    ...b, lines: b.lines.flatMap((line) => wrap(c.fonts, line, 7.5, colWidth - 14)),
  }));
  const height = 28 + Math.max(...wrapped.map((b) => b.lines.length)) * 9.5;
  c.ensure(height + 8, () => drawHeader(c, model, true));
  wrapped.forEach((block, i) => {
    const x = MARGIN + i * (colWidth + gap);
    c.page.drawRectangle({ x, y: c.y - height, width: colWidth, height, borderColor: LINE, borderWidth: 0.7 });
    c.drawText(block.label, x + 7, c.y - 12, 7.3, { bold: true, color: MUTED });
    let lineY = c.y - 24;
    for (const line of block.lines) {
      c.drawText(line, x + 7, lineY, 7.5);
      lineY -= 9.5;
    }
  });
  c.y -= height + 9;
}

function tableDefinition(model: PdfModel, usable: number): { columns: TableColumn[]; rows: string[][] } {
  if (model.kind === 'PL') {
    const columns: TableColumn[] = [
      { label: '#', width: 0.04, align: 'center' }, { label: 'SKU', width: 0.10 },
      { label: 'Description', width: 0.34 }, { label: 'Qty/ctn', width: 0.09, align: 'right' },
      { label: 'Qty', width: 0.08, align: 'right' }, { label: 'Cartons', width: 0.09, align: 'right' },
      { label: 'Net kg', width: 0.12, align: 'right' }, { label: 'Gross kg', width: 0.14, align: 'right' },
    ];
    return { columns: columns.map((col) => ({ ...col, width: col.width * usable })), rows: model.lineItems.map((li, i) => {
      const cartons = li.cartons > 0 ? li.cartons : (li.ctn_qty ? Math.ceil(li.qty / li.ctn_qty) : 0);
      const net = li.unit_net_weight_g === null ? 'TBD' : ((li.qty * li.unit_net_weight_g) / 1000).toFixed(3);
      const gross = li.ctn_weight_gross_kg === null ? 'TBD' : (cartons * li.ctn_weight_gross_kg).toFixed(3);
      return [String(i + 1), li.product_id, pickLineLabel(li, { kind: 'PL', partnerLang: isRussian(model.language, model.kind) ? 'RU' : 'EN' }), String(li.ctn_qty ?? ''), String(li.qty), String(cartons), net, gross];
    }) };
  }
  if (model.kind === 'TN') {
    const columns: TableColumn[] = [
      { label: '#', width: 0.05, align: 'center' }, { label: 'Наименование груза', width: 0.58 },
      { label: 'Кол-во', width: 0.13, align: 'right' }, { label: 'Ед.', width: 0.10, align: 'center' },
      { label: 'Картоны', width: 0.14, align: 'right' },
    ];
    return { columns: columns.map((col) => ({ ...col, width: col.width * usable })), rows: model.lineItems.map((li, i) => [
      String(i + 1), pickLineLabel(li, { kind: 'TN' }), String(li.qty), 'шт', String(li.cartons ?? 0),
    ]) };
  }
  const columns: TableColumn[] = [
    { label: '#', width: 0.035, align: 'center' }, { label: 'SKU', width: 0.075 },
    { label: 'Description', width: 0.32 }, { label: 'HS code', width: 0.10, align: 'center' },
    { label: 'Origin', width: 0.08, align: 'center' }, { label: 'Qty', width: 0.07, align: 'right' },
    { label: 'Unit', width: 0.055, align: 'center' }, { label: 'Unit price', width: 0.12, align: 'right' },
    { label: 'Amount', width: 0.145, align: 'right' },
  ];
  const rows = model.lineItems.map((li, i) => [
    String(i + 1), li.product_id,
    model.kind === 'UPD'
      ? pickLineLabel(li, { kind: 'UPD' })
      : model.kind === 'IS-V1' || model.kind === 'IS-V2'
        ? pickLineLabel(li, { kind: 'IS', variant: model.kind === 'IS-V1' ? 'V1' : 'V2' })
        : pickLineLabel(li, { kind: 'CI', partnerLang: isRussian(model.language, model.kind) ? 'RU' : 'EN' }),
    li.hs_code ?? '', li.country_of_origin ?? '', String(li.qty), 'pcs',
    model.currency ? formatUnitPrice(li.unit_price_after_disc, model.currency) : String(li.unit_price_after_disc),
    model.currency ? formatMoney(li.line_amount, model.currency) : String(li.line_amount),
  ]);
  model.extraCharges.forEach((charge) => rows.push([
    String(rows.length + 1), '', charge.label, '', '', '', '', '',
    model.currency ? formatMoney(charge.amount, model.currency) : String(charge.amount),
  ]));
  return { columns: columns.map((col) => ({ ...col, width: col.width * usable })), rows };
}

function drawTableHeader(c: PdfCanvas, columns: TableColumn[]): void {
  const height = 24;
  let x = MARGIN;
  for (const col of columns) {
    c.page.drawRectangle({ x, y: c.y - height, width: col.width, height, color: SHADE, borderColor: LINE, borderWidth: 0.6 });
    const lines = wrap(c.fonts, col.label, 6.5, col.width - 7);
    let y = c.y - 9;
    for (const line of lines.slice(0, 2)) {
      c.drawText(line, x + 3.5, y, 6.5, { bold: true, maxWidth: col.width - 7, align: col.align ?? 'left' });
      y -= 8;
    }
    x += col.width;
  }
  c.y -= height;
}

function drawTable(c: PdfCanvas, model: PdfModel): void {
  const usable = c.page.getWidth() - MARGIN * 2;
  const { columns, rows } = tableDefinition(model, usable);
  drawTableHeader(c, columns);
  for (const row of rows) {
    const wrapped = row.map((value, i) => wrap(c.fonts, value, 6.6, (columns[i]?.width ?? 20) - 7));
    const height = Math.max(18, Math.max(...wrapped.map((lines) => lines.length)) * 8 + 6);
    c.ensure(height + 4, () => { drawHeader(c, model, true); drawTableHeader(c, columns); });
    let x = MARGIN;
    columns.forEach((col, i) => {
      c.page.drawRectangle({ x, y: c.y - height, width: col.width, height, borderColor: LINE, borderWidth: 0.5 });
      let y = c.y - 10;
      for (const line of wrapped[i] ?? ['']) {
        c.drawText(line, x + 3.5, y, 6.6, { maxWidth: col.width - 7, align: col.align ?? 'left' });
        y -= 8;
      }
      x += col.width;
    });
    c.y -= height;
  }
  c.y -= 8;
}

async function embedSignatureImage(
  doc: PDFDocument,
  image: { data: Uint8Array; format: 'png' | 'jpg' },
): Promise<PDFImage> {
  return image.format === 'jpg' ? doc.embedJpg(image.data) : doc.embedPng(image.data);
}

async function drawSignature(c: PdfCanvas, model: PdfModel): Promise<void> {
  const sig = model.signature;
  const requiredHeight = 238;
  c.ensure(requiredHeight, () => drawHeader(c, model, true));
  const rightWidth = Math.min(320, c.page.getWidth() - MARGIN * 2);
  const x = c.page.getWidth() - MARGIN - rightWidth;
  if (model.total !== null && model.currency) {
    c.drawText(isRussian(model.language, model.kind) ? 'ИТОГО' : 'TOTAL', MARGIN, c.y - 18, 10, { bold: true });
    c.drawText(formatMoney(model.total, model.currency), MARGIN + 70, c.y - 18, 10, { bold: true });
    if (model.kind === 'UPD' && model.vatRatePct !== undefined) {
      c.drawText(`VAT / НДС: ${model.vatRatePct}%`, MARGIN, c.y - 34, 8);
    }
  }
  c.drawText(isRussian(model.language, model.kind) ? 'Уполномоченная подпись' : 'Authorised signature', x, c.y - 14, 8, { bold: true });
  const stamp = sig.stamp ? await embedSignatureImage(c.doc, sig.stamp) : null;
  if (stamp && sig.stamp) {
    const maxW = 290;
    const maxH = 180;
    const scale = Math.min(maxW / stamp.width, maxH / stamp.height);
    const w = stamp.width * scale;
    const h = stamp.height * scale;
    c.page.drawImage(stamp, { x: x + rightWidth - w, y: c.y - 194, width: w, height: h });
  }
  if (sig.handSignature) {
    const hand = await embedSignatureImage(c.doc, sig.handSignature);
    const maxW = 300;
    const maxH = 90;
    const scale = Math.min(maxW / hand.width, maxH / hand.height);
    const w = hand.width * scale;
    const h = hand.height * scale;
    c.page.drawImage(hand, { x: x + rightWidth - w - 8, y: c.y - 148, width: w, height: h });
  }
  const title = isRussian(model.language, model.kind)
    ? (sig.titleRu ?? sig.titleEn ?? 'Генеральный директор')
    : (sig.titleEn ?? sig.titleRu ?? 'General Manager');
  c.drawText(title, x, c.y - 212, 8, { bold: true });
  if (sig.name) c.drawText(sig.name, x, c.y - 226, 8);
  c.y -= requiredHeight;
}

async function createPdf(model: PdfModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bytes = pdfFontBytes();
  // This font is already reduced to the ERP Latin/Cyrillic/Vietnamese ranges.
  // Embedding it whole preserves its cmap in macOS Preview and Acrobat.
  const noto = await doc.embedFont(bytes);
  const fonts: FontSet = {
    latin: noto,
    cyrillic: noto,
    vietnamese: noto,
  };
  doc.setTitle(`${model.title} ${model.reference}`);
  doc.setSubject(`${model.kind} issued by dasoperator ERP`);
  doc.setAuthor('Das Experten');
  doc.setCreator('dasoperator-api deterministic PDF renderer');
  doc.setProducer('pdf-lib; no external conversion service');
  doc.setCreationDate(new Date(model.issuedAt * 1000));
  doc.setModificationDate(new Date(model.issuedAt * 1000));

  const canvas = new PdfCanvas(doc, fonts, model.kind === 'IS-V1' || model.kind === 'IS-V2' || model.kind === 'UPD' || model.kind === 'TN');
  drawHeader(canvas, model);
  drawPartyGrid(canvas, model);
  drawHighlightedParties(canvas, model);
  drawInfo(canvas, model);
  drawTable(canvas, model);
  await drawSignature(canvas, model);
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

export function renderCommercialInvoicePdf(input: RenderCiInput): Promise<Uint8Array> {
  const ru = isRussian(input.language, 'CI');
  return createPdf({
    kind: 'CI', title: input.language === 'RU' ? 'КОММЕРЧЕСКИЙ ИНВОЙС' : 'COMMERCIAL INVOICE',
    reference: input.reference, issuedAt: input.issuedAt, language: input.language,
    currency: input.currency,
    parties: [
      { label: ru ? 'ПРОДАВЕЦ' : 'SELLER', party: input.seller },
      { label: ru ? 'ПОКУПАТЕЛЬ' : 'BUYER', party: input.buyer },
    ],
    highlightedParties: input.shipperLine
      ? [{ label: ru ? 'ГРУЗООТПРАВИТЕЛЬ' : 'SHIPPER', lines: [input.shipperLine] }]
      : [],
    details: [
      `Incoterms: ${input.incoterms}`,
      ...(input.paymentTerms ? [`Payment: ${input.paymentTerms}`] : []),
      ...(input.contract ? [`Contract: ${input.contract.contract_no}`] : []),
    ],
    bank: input.bank, lineItems: input.lineItems, total: input.totalMinor,
    extraCharges: input.extraCharges ?? [], signature: input.signature,
  });
}

export function renderPackingListPdf(input: RenderPlInput): Promise<Uint8Array> {
  const ru = isRussian(input.language, 'PL');
  return createPdf({
    kind: 'PL', title: input.language === 'RU' ? 'УПАКОВОЧНЫЙ ЛИСТ' : 'PACKING LIST',
    reference: input.reference, issuedAt: input.issuedAt, language: input.language,
    currency: null,
    parties: [
      { label: ru ? 'ПРОДАВЕЦ' : 'SELLER', party: input.shipper },
      { label: ru ? 'ГРУЗОПОЛУЧАТЕЛЬ' : 'CONSIGNEE', party: input.consignee },
    ],
    highlightedParties: input.physicalShipperLine
      ? [{ label: ru ? 'ГРУЗООТПРАВИТЕЛЬ' : 'SHIPPER', lines: [input.physicalShipperLine] }]
      : [],
    details: [
      ...(input.ciReference ? [`Related invoice: ${input.ciReference}`] : []),
    ], bank: null,
    lineItems: input.lineItems, total: null, extraCharges: [], signature: input.signature,
  });
}

export function renderInvoiceSpecBrushesPdf(input: RenderIsV1Input): Promise<Uint8Array> {
  const parties: PdfPartyBlock[] = [
    { label: 'SHIPPER / ОТПРАВИТЕЛЬ', party: input.shipper },
    { label: 'CONSIGNEE / BUYER', party: input.buyer },
  ];
  if (input.sellerDistinctFromShipper) parties.push({ label: 'SELLER / ПРОДАВЕЦ', party: input.seller });
  return createPdf({
    kind: 'IS-V1', title: 'INVOICE-SPECIFICATION / СЧЁТ-СПЕЦИФИКАЦИЯ',
    reference: input.reference, issuedAt: input.issuedAt, language: 'BILINGUAL', currency: input.currency,
    parties, details: [input.incoterms, ...(input.consigneeAtTerminal ? [`Consignee at terminal: ${input.consigneeAtTerminal}`] : [])],
    bank: input.bank, lineItems: input.lineItems, total: input.totalMinor, extraCharges: [], signature: input.signature,
  });
}

export function renderInvoiceSpecPastesPdf(input: RenderIsV2Input): Promise<Uint8Array> {
  return createPdf({
    kind: 'IS-V2', title: 'INVOICE-SPECIFICATION / ИНВОЙС-СПЕЦИФИКАЦИЯ',
    reference: input.reference, issuedAt: input.issuedAt, language: 'BILINGUAL', currency: input.currency,
    parties: [{ label: 'SHIPPER / SELLER', party: input.shipperSeller }, { label: 'CONSIGNEE / BUYER', party: input.consigneeBuyer }],
    details: [input.incoterms, ...(input.container ? [`Container: ${input.container}`] : []), ...(input.countryStation ? [`Country / Station: ${input.countryStation}`] : [])],
    bank: input.bank, lineItems: input.lineItems, total: input.totalMinor, extraCharges: [], signature: input.signature,
  });
}

export function renderUpdPdf(input: RenderUpdInput): Promise<Uint8Array> {
  return createPdf({
    kind: 'UPD', title: 'УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ',
    reference: input.reference, issuedAt: input.issuedAt, language: 'RU', currency: input.currency,
    parties: [{ label: 'ПРОДАВЕЦ', party: input.seller }, { label: 'ПОКУПАТЕЛЬ', party: input.buyer }],
    details: [
      `Статус: ${input.status ?? 1}`,
      ...(input.contract ? [`Договор: ${input.contract.contract_no}`] : []),
      ...(input.shipmentDocNumber ? [`Документ об отгрузке: ${input.shipmentDocNumber}`] : []),
    ],
    bank: null, lineItems: input.lineItems, total: input.totalMinor, extraCharges: [],
    signature: input.signature, vatRatePct: input.vatRatePct,
  });
}

export function renderTnPdf(input: RenderTnInput): Promise<Uint8Array> {
  return createPdf({
    kind: 'TN', title: 'ТРАНСПОРТНАЯ НАКЛАДНАЯ',
    reference: input.reference, issuedAt: input.issuedAt, language: 'RU', currency: null,
    parties: [{ label: 'ГРУЗООТПРАВИТЕЛЬ', party: input.shipper }, { label: 'ГРУЗОПОЛУЧАТЕЛЬ', party: input.consignee }],
    details: [
      ...(input.contract ? [`Договор: ${input.contract.contract_no}`] : []),
      ...(input.upcomingUpdRef ? [`УПД: ${input.upcomingUpdRef}`] : []),
    ],
    bank: null, lineItems: input.lineItems, total: null, extraCharges: [], signature: input.signature,
  });
}
