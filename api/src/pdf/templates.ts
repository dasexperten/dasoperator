// =============================================================================
// PDF templates — Commercial Invoice (CI) and Packing List (PL)
// Built with pdf-lib using StandardFonts.Helvetica (WinAnsi only). Non-Latin
// characters (Cyrillic legal names) are transliterated to a safe ASCII form
// because Helvetica cannot encode glyphs outside Latin-1.
// =============================================================================

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { InvoiceData, PackingListData, PartyBlock } from './types';

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN_X = 40;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;

const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_MUTED = rgb(0.4, 0.4, 0.4);
const COLOR_LINE = rgb(0.75, 0.75, 0.75);

// =============================================================================
// Encoding helpers — Helvetica only supports WinAnsi (Latin-1). Strip / map
// anything outside that range so drawText doesn't throw.
// =============================================================================

const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'Zh', З: 'Z',
  И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R',
  С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'Kh', Ц: 'Ts', Ч: 'Ch', Ш: 'Sh',
  Щ: 'Shch', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'Yu', Я: 'Ya',
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function safeText(input: string | null | undefined): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    const cyr = CYRILLIC_TO_LATIN[ch];
    if (cyr !== undefined) {
      out += cyr;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code <= 0xff) {
      out += ch;
    } else {
      // Vietnamese diacritics, CJK, etc. — replace with placeholder.
      out += '?';
    }
  }
  return out;
}

// =============================================================================
// Money / weight formatting
// =============================================================================

function formatMoney(amountMinor: number, currency: string, minorFactor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  if (minorFactor === 1) {
    return `${currency} ${sign}${abs.toLocaleString('en-US')}`;
  }
  const major = Math.floor(abs / minorFactor);
  const minor = abs % minorFactor;
  return `${currency} ${sign}${major.toLocaleString('en-US')}.${String(minor).padStart(2, '0')}`;
}

function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatWeightKg(grams: number | null): string {
  if (grams === null || grams === undefined) return 'TBD';
  return (grams / 1000).toFixed(3);
}

function formatVolumeM3(microL: number | null): string {
  // volume_m3_micro stores microlitres × 1000 (per schema comment).
  // 1 m³ = 1,000,000,000 microlitres → divisor = 1e12 to get m³.
  if (microL === null || microL === undefined) return 'TBD';
  const m3 = microL / 1_000_000_000_000;
  return m3.toFixed(4);
}

// =============================================================================
// Drawing primitives
// =============================================================================

interface DrawCtx {
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;
}

function drawLine(page: PDFPage, x1: number, y: number, x2: number) {
  page.drawLine({
    start: { x: x1, y },
    end: { x: x2, y },
    thickness: 0.5,
    color: COLOR_LINE,
  });
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = COLOR_TEXT
) {
  page.drawText(safeText(text), { x, y, size, font, color });
}

function drawPartyBlock(
  ctx: DrawCtx,
  title: string,
  party: PartyBlock,
  x: number,
  width: number,
  showBank: boolean
): number {
  const { page, font, fontBold } = ctx;
  let y = ctx.y;

  drawText(page, title, x, y, fontBold, 9, COLOR_MUTED);
  y -= 14;

  const name = party.tradeName || party.legalName;
  drawText(page, name, x, y, fontBold, 11);
  y -= 14;

  if (party.tradeName && party.legalName && party.tradeName !== party.legalName) {
    drawText(page, party.legalName, x, y, font, 8, COLOR_MUTED);
    y -= 11;
  }

  if (party.address) {
    for (const chunk of wrapText(party.address, font, 9, width)) {
      drawText(page, chunk, x, y, font, 9);
      y -= 11;
    }
  }
  if (party.taxId) {
    drawText(page, `Tax ID: ${party.taxId}`, x, y, font, 9);
    y -= 11;
  }
  if (party.email) {
    drawText(page, `Email: ${party.email}`, x, y, font, 9);
    y -= 11;
  }

  if (showBank) {
    const bankFields: Array<[string, string | null | undefined]> = [
      ['Bank', party.bankName],
      ['Account', party.bankAccount],
      ['SWIFT', party.swift],
      ['IBAN', party.iban],
    ];
    const hasBank = bankFields.some(([, v]) => v);
    if (hasBank) {
      y -= 4;
      for (const [label, val] of bankFields) {
        drawText(page, `${label}: ${val || 'TBD'}`, x, y, font, 9);
        y -= 11;
      }
    }
  }

  return y;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = safeText(text);
  const words = safe.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const w = font.widthOfTextAtSize(candidate, size);
    if (w > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = safeText(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let cur = safe;
  while (cur.length > 1 && font.widthOfTextAtSize(`${cur}…`, size) > maxWidth) {
    cur = cur.slice(0, -1);
  }
  return `${cur}…`;
}

// =============================================================================
// Commercial Invoice
// =============================================================================

export async function renderCommercialInvoice(data: InvoiceData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Commercial Invoice ${data.reference}`);
  pdf.setProducer('dasoperator-api / pdf-lib');
  pdf.setCreator('dasoperator-api');

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const ctx: DrawCtx = { page, font, fontBold, y: PAGE_H - MARGIN_TOP };

  // Title
  const title = 'COMMERCIAL INVOICE';
  const titleSize = 20;
  const titleW = fontBold.widthOfTextAtSize(title, titleSize);
  drawText(page, title, (PAGE_W - titleW) / 2, ctx.y, fontBold, titleSize);
  ctx.y -= titleSize + 6;

  drawText(
    page,
    `No. ${data.reference}    Date: ${formatDate(data.issuedAt)}`,
    MARGIN_X,
    ctx.y,
    font,
    10,
    COLOR_MUTED
  );
  ctx.y -= 14;
  if (data.incoterms) {
    drawText(page, `Incoterms: ${data.incoterms}`, MARGIN_X, ctx.y, font, 10, COLOR_MUTED);
    ctx.y -= 14;
  }

  ctx.y -= 6;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 14;

  // Party blocks (Seller left, Buyer right)
  const colW = (PAGE_W - MARGIN_X * 2 - 20) / 2;
  const sellerY = drawPartyBlock(ctx, 'SELLER', data.seller, MARGIN_X, colW, true);
  const buyerY = drawPartyBlock(ctx, 'BUYER', data.buyer, MARGIN_X + colW + 20, colW, false);
  ctx.y = Math.min(sellerY, buyerY) - 12;

  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 16;

  // Line items table
  const cols = {
    n:    { x: MARGIN_X,        w: 22,  label: '#' },
    sku:  { x: MARGIN_X + 22,   w: 60,  label: 'SKU' },
    desc: { x: MARGIN_X + 82,   w: 200, label: 'Description' },
    hs:   { x: MARGIN_X + 282,  w: 55,  label: 'HS Code' },
    qty:  { x: MARGIN_X + 337,  w: 40,  label: 'Qty' },
    unit: { x: MARGIN_X + 377,  w: 65,  label: 'Unit Price' },
    tot:  { x: MARGIN_X + 442,  w: PAGE_W - MARGIN_X - (MARGIN_X + 442), label: 'Total' },
  };

  // Header
  drawText(page, cols.n.label, cols.n.x, ctx.y, fontBold, 9);
  drawText(page, cols.sku.label, cols.sku.x, ctx.y, fontBold, 9);
  drawText(page, cols.desc.label, cols.desc.x, ctx.y, fontBold, 9);
  drawText(page, cols.hs.label, cols.hs.x, ctx.y, fontBold, 9);
  drawText(page, cols.qty.label, cols.qty.x, ctx.y, fontBold, 9);
  drawText(page, cols.unit.label, cols.unit.x, ctx.y, fontBold, 9);
  drawText(page, cols.tot.label, cols.tot.x, ctx.y, fontBold, 9);
  ctx.y -= 6;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 12;

  let idx = 1;
  for (const line of data.lines) {
    if (ctx.y < MARGIN_BOTTOM + 30) break; // simple overflow guard
    drawText(page, String(idx), cols.n.x, ctx.y, font, 9);
    drawText(page, truncateToWidth(line.sku, font, 9, cols.sku.w - 2), cols.sku.x, ctx.y, font, 9);
    drawText(page, truncateToWidth(line.description, font, 9, cols.desc.w - 2), cols.desc.x, ctx.y, font, 9);
    drawText(page, line.hsCode || 'TBD', cols.hs.x, ctx.y, font, 9);
    drawText(page, String(line.qty), cols.qty.x, ctx.y, font, 9);
    drawText(
      page,
      formatMoney(line.unitPriceMinor, data.currency, data.minorFactor),
      cols.unit.x,
      ctx.y,
      font,
      9
    );
    drawText(
      page,
      formatMoney(line.lineTotalMinor, data.currency, data.minorFactor),
      cols.tot.x,
      ctx.y,
      font,
      9
    );
    ctx.y -= 14;
    idx++;
  }

  // Total
  ctx.y -= 4;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 18;

  const totalLabel = 'TOTAL';
  const totalValue = formatMoney(data.totalMinor, data.currency, data.minorFactor);
  drawText(page, totalLabel, cols.unit.x, ctx.y, fontBold, 12);
  drawText(page, totalValue, cols.tot.x, ctx.y, fontBold, 12);

  // Footer
  ctx.y = MARGIN_BOTTOM;
  drawLine(page, MARGIN_X, ctx.y + 20, PAGE_W - MARGIN_X);
  drawText(page, 'Prepared by Das Experten', MARGIN_X, ctx.y + 6, font, 9, COLOR_MUTED);
  if (data.preparedByCountry) {
    drawText(page, data.preparedByCountry, MARGIN_X, ctx.y - 6, font, 9, COLOR_MUTED);
  }

  return await pdf.save();
}

// =============================================================================
// Packing List
// =============================================================================

export async function renderPackingList(data: PackingListData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Packing List ${data.reference}`);
  pdf.setProducer('dasoperator-api / pdf-lib');
  pdf.setCreator('dasoperator-api');

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const ctx: DrawCtx = { page, font, fontBold, y: PAGE_H - MARGIN_TOP };

  const title = 'PACKING LIST';
  const titleSize = 20;
  const titleW = fontBold.widthOfTextAtSize(title, titleSize);
  drawText(page, title, (PAGE_W - titleW) / 2, ctx.y, fontBold, titleSize);
  ctx.y -= titleSize + 6;

  drawText(
    page,
    `No. ${data.reference}    Date: ${formatDate(data.issuedAt)}`,
    MARGIN_X,
    ctx.y,
    font,
    10,
    COLOR_MUTED
  );
  ctx.y -= 14;
  if (data.ciReference) {
    drawText(page, `Related CI: ${data.ciReference}`, MARGIN_X, ctx.y, font, 10, COLOR_MUTED);
    ctx.y -= 14;
  }

  ctx.y -= 6;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 14;

  const colW = (PAGE_W - MARGIN_X * 2 - 20) / 2;
  const sellerY = drawPartyBlock(ctx, 'SHIPPER', data.seller, MARGIN_X, colW, false);
  const buyerY = drawPartyBlock(ctx, 'CONSIGNEE', data.buyer, MARGIN_X + colW + 20, colW, false);
  ctx.y = Math.min(sellerY, buyerY) - 12;

  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 16;

  // Columns
  const cols = {
    n:    { x: MARGIN_X,        w: 22,  label: '#' },
    sku:  { x: MARGIN_X + 22,   w: 55,  label: 'SKU' },
    desc: { x: MARGIN_X + 77,   w: 150, label: 'Description' },
    hs:   { x: MARGIN_X + 227,  w: 55,  label: 'HS Code' },
    qty:  { x: MARGIN_X + 282,  w: 35,  label: 'Qty' },
    net:  { x: MARGIN_X + 317,  w: 55,  label: 'Net (kg)' },
    gross:{ x: MARGIN_X + 372,  w: 60,  label: 'Gross (kg)' },
    vol:  { x: MARGIN_X + 432,  w: PAGE_W - MARGIN_X - (MARGIN_X + 432), label: 'Vol (m3)' },
  };

  for (const c of Object.values(cols)) {
    drawText(page, c.label, c.x, ctx.y, fontBold, 9);
  }
  ctx.y -= 6;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 12;

  let totalQty = 0;
  let totalNetGrams = 0;
  let totalNetKnown = false;
  let totalVolMicroL = 0;
  let totalVolKnown = false;

  let idx = 1;
  for (const line of data.lines) {
    if (ctx.y < MARGIN_BOTTOM + 30) break;
    drawText(page, String(idx), cols.n.x, ctx.y, font, 9);
    drawText(page, truncateToWidth(line.sku, font, 9, cols.sku.w - 2), cols.sku.x, ctx.y, font, 9);
    drawText(page, truncateToWidth(line.description, font, 9, cols.desc.w - 2), cols.desc.x, ctx.y, font, 9);
    drawText(page, line.hsCode || 'TBD', cols.hs.x, ctx.y, font, 9);
    drawText(page, String(line.qty), cols.qty.x, ctx.y, font, 9);

    const netPerUnit = line.netWeightGrams;
    const netLineGrams = netPerUnit !== null ? netPerUnit * line.qty : null;
    drawText(
      page,
      netPerUnit !== null ? (netLineGrams! / 1000).toFixed(3) : 'TBD',
      cols.net.x,
      ctx.y,
      font,
      9
    );
    // Gross weight = net + 10% packaging assumption (TBD when net unknown)
    drawText(
      page,
      netPerUnit !== null ? ((netLineGrams! * 1.1) / 1000).toFixed(3) : 'TBD',
      cols.gross.x,
      ctx.y,
      font,
      9
    );

    const volPerUnit = line.volumeMicroL;
    const volLineMicroL = volPerUnit !== null ? volPerUnit * line.qty : null;
    drawText(
      page,
      volLineMicroL !== null ? formatVolumeM3(volLineMicroL) : 'TBD',
      cols.vol.x,
      ctx.y,
      font,
      9
    );

    totalQty += line.qty;
    if (netLineGrams !== null) {
      totalNetGrams += netLineGrams;
      totalNetKnown = true;
    }
    if (volLineMicroL !== null) {
      totalVolMicroL += volLineMicroL;
      totalVolKnown = true;
    }

    ctx.y -= 14;
    idx++;
  }

  // Totals
  ctx.y -= 4;
  drawLine(page, MARGIN_X, ctx.y, PAGE_W - MARGIN_X);
  ctx.y -= 18;

  drawText(page, 'TOTAL', cols.desc.x, ctx.y, fontBold, 11);
  drawText(page, String(totalQty), cols.qty.x, ctx.y, fontBold, 11);
  drawText(
    page,
    totalNetKnown ? formatWeightKg(totalNetGrams) : 'TBD',
    cols.net.x,
    ctx.y,
    fontBold,
    11
  );
  drawText(
    page,
    totalNetKnown ? formatWeightKg(totalNetGrams * 1.1) : 'TBD',
    cols.gross.x,
    ctx.y,
    fontBold,
    11
  );
  drawText(
    page,
    totalVolKnown ? formatVolumeM3(totalVolMicroL) : 'TBD',
    cols.vol.x,
    ctx.y,
    fontBold,
    11
  );

  ctx.y = MARGIN_BOTTOM;
  drawLine(page, MARGIN_X, ctx.y + 20, PAGE_W - MARGIN_X);
  drawText(page, 'Prepared by Das Experten', MARGIN_X, ctx.y + 6, font, 9, COLOR_MUTED);

  return await pdf.save();
}
