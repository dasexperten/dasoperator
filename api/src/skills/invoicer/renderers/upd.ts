// =============================================================================
// UPD — Универсальный передаточный документ.
// Полная официальная форма по Приложению № 1 к Постановлению Правительства РФ
// от 26.12.2011 № 1137 (в редакции Постановления от 16.08.2024 № 1096).
// Со строкой 5б (авансовые счета-фактуры) для версии с 01.04.2026.
// Статус 1 = счёт-фактура + передаточный документ; Статус 2 = только передаточный.
// =============================================================================

import type { ContractRow, LineItemRow } from '../types';
import {
  Document, Packer, LANDSCAPE_PAGE, LANDSCAPE_USABLE_DXA, RenderParty,
  RenderSignature, blank, formatDate, pickLineLabel,
} from './shared';
import {
  Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, TableLayoutType, HeightRule,
} from 'docx';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface RenderUpdInput {
  reference: string;             // Номер счёта-фактуры (UPD-DEE-260549)
  issuedAt: number;              // Дата составления (unix seconds)
  currency: string;              // ISO code, 'RUB' для УПД
  seller: RenderParty;
  buyer: RenderParty;
  signature: RenderSignature;
  contract: ContractRow | null;
  lineItems: LineItemRow[];
  totalMinor: number;            // Итого с НДС (рубли как число, не minor)
  vatRatePct: number;            // 0, 5, 20, 22
  status?: 1 | 2;                // По умолчанию 1
  // Опциональные шапочные поля
  consigneeShipper?: string | null;       // (3) Грузоотправитель — «он же» по умолчанию
  consigneeReceiver?: string | null;      // (4) Грузополучатель — по умолчанию buyer + адрес
  paymentRefNumber?: string | null;       // (5) К платёжно-расчётному документу № 
  paymentRefDate?: number | null;         // (5)   ... от
  shipmentDocNumber?: string | null;      // (5а) Документ об отгрузке: №
  shipmentDocDate?: number | null;        // (5а) ... от
  advanceInvoiceRefs?: string | null;     // (5б) реквизиты авансовых счетов-фактур (с 01.04.2026)
  govContractId?: string | null;          // (8) Идентификатор государственного контракта
}

// ---------------------------------------------------------------------------
// Currency dictionary — ISO 4217 cyfra → русское наименование
// ---------------------------------------------------------------------------

const CURRENCY_RU: Record<string, { name: string; code: string }> = {
  RUB: { name: 'российский рубль', code: '643' },
  USD: { name: 'доллар США',       code: '840' },
  EUR: { name: 'евро',              code: '978' },
  CNY: { name: 'юань',              code: '156' },
  AED: { name: 'дирхам ОАЭ',        code: '784' },
  VND: { name: 'донг',              code: '704' },
  AMD: { name: 'армянский драм',    code: '051' },
};

// ---------------------------------------------------------------------------
// Number formatting (Russian locale, two decimals, space thousands sep)
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Border styles
// ---------------------------------------------------------------------------

const BORDER_THIN = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const NO_BORDER   = { style: BorderStyle.NONE,   size: 0, color: 'FFFFFF' };

const ALL_BORDERS = {
  top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN,
  insideHorizontal: BORDER_THIN, insideVertical: BORDER_THIN,
} as const;

const CELL_BORDERS = {
  top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN,
} as const;

const NO_CELL_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
} as const;

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

interface CellOpts {
  bold?: boolean;
  align?: typeof AlignmentType[keyof typeof AlignmentType];
  size?: number;          // half-points (16 = 8pt, 18 = 9pt, 20 = 10pt)
  widthDxa?: number;
  borders?: typeof CELL_BORDERS | typeof NO_CELL_BORDERS;
  rowSpan?: number;
  colSpan?: number;
}

function cell(text: string | string[], opts: CellOpts = {}): TableCell {
  const lines = Array.isArray(text) ? text : [text];
  const paras = lines.map((line) =>
    new Paragraph({
      alignment: opts.align ?? AlignmentType.LEFT,
      spacing: { before: 0, after: 0, line: 220 },
      children: [new TextRun({ text: line, bold: opts.bold ?? false, size: opts.size ?? 16, font: 'Times New Roman' })],
    })
  );
  return new TableCell({
    children: paras,
    width: opts.widthDxa !== undefined ? { size: opts.widthDxa, type: WidthType.DXA } : undefined,
    borders: opts.borders ?? CELL_BORDERS,
    rowSpan: opts.rowSpan,
    columnSpan: opts.colSpan,
  });
}

// ---------------------------------------------------------------------------
// Page-top: APPENDIX REFERENCE (right-aligned, italic, small)
// ---------------------------------------------------------------------------

function appendixReference(): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: { before: 0, after: 60 },
    children: [
      new TextRun({
        text: 'Приложение № 1 к постановлению Правительства РФ от 26.12.2011 № 1137 (в редакции постановления Правительства РФ от 16.08.2024 № 1096)',
        size: 14, italics: true, font: 'Times New Roman',
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Title block
// ---------------------------------------------------------------------------

function titleBlock(status: 1 | 2): Paragraph[] {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 60 },
      children: [new TextRun({ text: 'Универсальный передаточный документ', bold: true, size: 24, font: 'Times New Roman' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 120 },
      children: [
        new TextRun({ text: 'Статус: ', size: 18, font: 'Times New Roman' }),
        new TextRun({ text: String(status), bold: true, size: 18, font: 'Times New Roman' }),
        new TextRun({
          text: status === 1
            ? '  (1 — счёт-фактура и передаточный документ (акт))'
            : '  (2 — передаточный документ (акт))',
          size: 16, font: 'Times New Roman',
        }),
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// HEADER BLOCK — strict layout per ПП 1137 (rows 1, 1a, 2-2б, 3-4, 5-5а-5б, 6-6б, 7, 8)
// One narrow table; each label fixed width, value fills the rest, "(N)" code on the right.
// ---------------------------------------------------------------------------

interface HeaderField {
  label: string;
  value: string;
  code: string;   // "(1)", "(2а)", etc.
  bold?: boolean;
}

function buildHeader(input: RenderUpdInput): Table {
  const issuedDate = formatDate(input.issuedAt);
  const sellerAddr = input.seller.addressLocal ?? input.seller.addressEn ?? '';
  const sellerInnKpp = [
    input.seller.inn ?? input.seller.taxId,
    input.seller.kpp,
  ].filter(Boolean).join(' / ');
  const buyerAddr = input.buyer.addressLocal ?? input.buyer.addressEn ?? '';
  const buyerInnKpp = [
    input.buyer.inn ?? input.buyer.taxId,
    input.buyer.kpp,
  ].filter(Boolean).join(' / ');

  const currencyName = CURRENCY_RU[input.currency]?.name ?? input.currency;
  const currencyCode = CURRENCY_RU[input.currency]?.code ?? '';

  const shipperLine = input.consigneeShipper ?? 'он же';
  const consigneeLine = input.consigneeReceiver
    ?? [input.buyer.legalNameLocal ?? input.buyer.legalNameEn ?? '', buyerAddr].filter(Boolean).join(', ');

  // (5) К платёжно-расчётному документу
  const paymentRef = (input.paymentRefNumber || input.paymentRefDate)
    ? `№ ${input.paymentRefNumber ?? '—'}    от ${input.paymentRefDate ? formatDate(input.paymentRefDate) : '—'}`
    : '—';

  // (5а) Документ об отгрузке
  const shipmentRef = (input.shipmentDocNumber || input.shipmentDocDate)
    ? `${input.shipmentDocNumber ?? '—'} от ${input.shipmentDocDate ? formatDate(input.shipmentDocDate) : '—'}`
    : '—';

  const fields: HeaderField[] = [
    { label: 'Счёт-фактура',                                                value: `№ ${input.reference}    от ${issuedDate}`, code: '(1)',  bold: true },
    { label: 'Исправление',                                                  value: '№ —    от —',                              code: '(1а)' },
    { label: 'Продавец',                                                     value: input.seller.legalNameLocal ?? input.seller.legalNameEn ?? '', code: '(2)' },
    { label: 'Адрес',                                                        value: sellerAddr,                                  code: '(2а)' },
    { label: 'ИНН/КПП продавца',                                             value: sellerInnKpp,                                code: '(2б)' },
    { label: 'Грузоотправитель и его адрес',                                 value: shipperLine,                                 code: '(3)' },
    { label: 'Грузополучатель и его адрес',                                  value: consigneeLine,                               code: '(4)' },
    { label: 'К платёжно-расчётному документу',                              value: paymentRef,                                  code: '(5)' },
    { label: 'Документ об отгрузке: наименование, № и дата',                 value: shipmentRef,                                 code: '(5а)' },
    // (5б) появилась с 01.04.2026 — реквизиты авансовых счетов-фактур.
    { label: 'Реквизиты счетов-фактур на ранее полученную оплату',           value: input.advanceInvoiceRefs ?? '—',             code: '(5б)' },
    { label: 'Покупатель',                                                   value: input.buyer.legalNameLocal ?? input.buyer.legalNameEn ?? '', code: '(6)' },
    { label: 'Адрес',                                                        value: buyerAddr,                                   code: '(6а)' },
    { label: 'ИНН/КПП покупателя',                                           value: buyerInnKpp,                                 code: '(6б)' },
    { label: 'Валюта: наименование, код',                                    value: `${currencyName}, ${currencyCode}`.trim(),   code: '(7)' },
    { label: 'Идентификатор государственного контракта, договора (соглашения)', value: input.govContractId ?? '—',               code: '(8)' },
  ];

  // Grid: [Label 3500] [Value 11400] [Code 500]
  const TOTAL = LANDSCAPE_USABLE_DXA;
  const W_LABEL = 3500;
  const W_CODE  = 500;
  const W_VALUE = TOTAL - W_LABEL - W_CODE;

  const rows = fields.map((f) =>
    new TableRow({
      children: [
        cell(f.label,  { widthDxa: W_LABEL, size: 16, borders: NO_CELL_BORDERS }),
        cell(f.value,  { widthDxa: W_VALUE, size: 16, bold: f.bold, borders: NO_CELL_BORDERS }),
        cell(f.code,   { widthDxa: W_CODE,  size: 14, align: AlignmentType.RIGHT, borders: NO_CELL_BORDERS }),
      ],
      height: { value: 240, rule: HeightRule.ATLEAST },
    })
  );

  return new Table({
    rows,
    width: { size: TOTAL, type: WidthType.DXA },
    columnWidths: [W_LABEL, W_VALUE, W_CODE],
    layout: TableLayoutType.FIXED,
    borders: {
      top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'BFBFBF' },
      insideVertical: NO_BORDER,
    },
  });
}

// ---------------------------------------------------------------------------
// MAIN TABLE — 14 official columns + ordinal headings
// Per ПП 1137 col indices: А, 1, 1а, 1б, 2, 2а, 3, 4, 5, 6, 7, 8, 9, 10, 10а, 11, 12, 12а, 13, 14
// We render the full 20-column grid faithfully.
// ---------------------------------------------------------------------------

function buildMainTable(input: RenderUpdInput): Table {
  const vatRateLabel = input.vatRatePct === 0 ? 'Без НДС' : `${input.vatRatePct}%`;

  // 20-column widths — sum must equal LANDSCAPE_USABLE_DXA (15400)
  const W = [
    700,   // A   Код товара
    400,   // 1   № п/п
    2400,  // 1а  Наименование
    600,   // 1б  Код вида товара
    500,   // 2   ед. изм. код
    700,   // 2а  ед. изм. обозн.
    800,   // 3   Количество
    900,   // 4   Цена
    1100,  // 5   Стоимость без НДС
    600,   // 6   Акциз
    600,   // 7   Ставка НДС
    1000,  // 8   Сумма НДС
    1200,  // 9   Стоимость с НДС
    500,   // 10  Страна код
    600,   // 10а Страна название
    800,   // 11  Регистрационный номер
    400,   // 12  ед.прослеж. код
    500,   // 12а ед.прослеж. обозн.
    600,   // 13  кол-во прослеж.
    500,   // 14  стоимость прослеж.
  ];
  // sum check: 700+400+2400+600+500+700+800+900+1100+600+600+1000+1200+500+600+800+400+500+600+500 = 15400

  // --- Heading row (full labels, all 20 columns) ---
  const labels = [
    'Код товара/ работ, услуг',
    '№ п/п',
    'Наименование товара (описание выполненных работ, оказанных услуг), имущественного права',
    'Код вида товара',
    'Ед. изм. (код)',
    'Ед. изм. (обозначение)',
    'Количество (объём)',
    'Цена (тариф) за единицу измерения',
    'Стоимость без налога — всего',
    'В т.ч. сумма акциза',
    'Налоговая ставка',
    'Сумма налога, предъявляемая покупателю',
    'Стоимость с налогом — всего',
    'Страна происхождения (код)',
    'Страна происхождения (название)',
    'Регистрационный номер декларации / партии прослеживаемости',
    'Ед. прослеживаемости (код)',
    'Ед. прослеживаемости (обозначение)',
    'Количество, подлежащее прослеживаемости',
    'Стоимость, подлежащая прослеживаемости, без НДС',
  ];
  const heading1 = new TableRow({
    tableHeader: true,
    children: labels.map((label, i) =>
      cell(label, { widthDxa: W[i], size: 12, align: AlignmentType.CENTER, bold: true })
    ),
  });

  // --- Ordinal numbers row — А, 1, 1а, 1б, 2, 2а, 3..., 14 ---
  const ordinals = ['А', '1', '1а', '1б', '2', '2а', '3', '4', '5', '6', '7', '8', '9', '10', '10а', '11', '12', '12а', '13', '14'];
  const heading2 = new TableRow({
    tableHeader: true,
    children: ordinals.map((o, i) =>
      cell(o, { widthDxa: W[i], size: 14, align: AlignmentType.CENTER, bold: true })
    ),
  });

  // --- Data rows ---
  const dataRows = input.lineItems.map((li, idx) => {
    const qty = li.qty;
    const unitPrice = li.unit_price_after_disc;
    const lineWithVat = li.line_amount;
    const lineNoVat = input.vatRatePct > 0 ? lineWithVat / (1 + input.vatRatePct / 100) : lineWithVat;
    const lineVat = lineWithVat - lineNoVat;

    const cells = [
      cell('—',                              { widthDxa: W[0],  size: 14, align: AlignmentType.CENTER }),
      cell(String(idx + 1),              { widthDxa: W[1],  size: 14, align: AlignmentType.CENTER }),
      cell(pickLineLabel(li, { kind: 'UPD', partnerLang: 'RU' }), { widthDxa: W[2], size: 14, align: AlignmentType.LEFT }),
      cell('—',                              { widthDxa: W[3],  size: 14, align: AlignmentType.CENTER }),
      cell('796',                            { widthDxa: W[4],  size: 14, align: AlignmentType.CENTER }),
      cell('шт',                             { widthDxa: W[5],  size: 14, align: AlignmentType.CENTER }),
      cell(String(qty),                      { widthDxa: W[6],  size: 14, align: AlignmentType.RIGHT }),
      cell(fmt(unitPrice),                   { widthDxa: W[7],  size: 14, align: AlignmentType.RIGHT }),
      cell(fmt(lineNoVat),                   { widthDxa: W[8],  size: 14, align: AlignmentType.RIGHT }),
      cell('без акциза',                     { widthDxa: W[9],  size: 14, align: AlignmentType.CENTER }),
      cell(vatRateLabel,                     { widthDxa: W[10], size: 14, align: AlignmentType.CENTER }),
      cell(fmt(lineVat),                     { widthDxa: W[11], size: 14, align: AlignmentType.RIGHT }),
      cell(fmt(lineWithVat),                 { widthDxa: W[12], size: 14, align: AlignmentType.RIGHT }),
      cell('—',                              { widthDxa: W[13], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[14], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[15], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[16], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[17], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[18], size: 14, align: AlignmentType.CENTER }),
      cell('—',                              { widthDxa: W[19], size: 14, align: AlignmentType.CENTER }),
    ];
    return new TableRow({ children: cells });
  });

  // --- Total row "Всего к оплате (9)" — spans first 7 cols ---
  const totalNoVat = input.vatRatePct > 0 ? input.totalMinor / (1 + input.vatRatePct / 100) : input.totalMinor;
  const totalVat   = input.totalMinor - totalNoVat;

  // Total row: each of the 20 cells listed explicitly (no colSpan to avoid docx vMerge edge cases).
  // Label "Всего к оплате (9)" sits in the Description cell (index 2); numeric totals in cols 5, 7, 8, 9.
  const totalCells = [
    cell('',  { widthDxa: W[0], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('',  { widthDxa: W[1], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('Всего к оплате (9)', { widthDxa: W[2], size: 14, align: AlignmentType.RIGHT, bold: true }),
    cell('',  { widthDxa: W[3], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('',  { widthDxa: W[4], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('',  { widthDxa: W[5], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('',  { widthDxa: W[6], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('',  { widthDxa: W[7], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell(fmt(totalNoVat),       { widthDxa: W[8],  size: 14, align: AlignmentType.RIGHT, bold: true }),
    cell('Х',                    { widthDxa: W[9],  size: 14, align: AlignmentType.CENTER, bold: true }),
    cell('Х',                    { widthDxa: W[10], size: 14, align: AlignmentType.CENTER, bold: true }),
    cell(fmt(totalVat),         { widthDxa: W[11], size: 14, align: AlignmentType.RIGHT, bold: true }),
    cell(fmt(input.totalMinor), { widthDxa: W[12], size: 14, align: AlignmentType.RIGHT, bold: true }),
    cell('', { widthDxa: W[13], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[14], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[15], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[16], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[17], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[18], size: 14, align: AlignmentType.CENTER }),
    cell('', { widthDxa: W[19], size: 14, align: AlignmentType.CENTER }),
  ];
  const totalRow = new TableRow({ children: totalCells });

  return new Table({
    rows: [heading1, heading2, ...dataRows, totalRow],
    width: { size: LANDSCAPE_USABLE_DXA, type: WidthType.DXA },
    columnWidths: W,
    layout: TableLayoutType.FIXED,
    borders: ALL_BORDERS,
  });
}

// ---------------------------------------------------------------------------
// SIGNATURE BLOCK — official wording, two columns (продавец / покупатель)
// ---------------------------------------------------------------------------

function buildSignaturesAndFooter(input: RenderUpdInput): (Paragraph | Table)[] {
  const sigName = input.signature.name ?? '';
  const headerRole = input.signature.titleRu ?? 'Руководитель организации или иное уполномоченное лицо';

  const para = (text: string, opts: { bold?: boolean; size?: number; align?: typeof AlignmentType[keyof typeof AlignmentType]; spaceAfter?: number } = {}) =>
    new Paragraph({
      alignment: opts.align ?? AlignmentType.LEFT,
      spacing: { before: 0, after: opts.spaceAfter ?? 60, line: 240 },
      children: [new TextRun({ text, bold: opts.bold ?? false, size: opts.size ?? 16, font: 'Times New Roman' })],
    });

  // Block 1: Руководитель + Главбух (по строке счёта-фактуры)
  const directorRow = new Table({
    width: { size: LANDSCAPE_USABLE_DXA, type: WidthType.DXA },
    columnWidths: [7700, 7700],
    layout: TableLayoutType.FIXED,
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [
      new TableRow({
        children: [
          cell(headerRole, { widthDxa: 7700, size: 16, borders: NO_CELL_BORDERS }),
          cell('Главный бухгалтер или иное уполномоченное лицо', { widthDxa: 7700, size: 16, borders: NO_CELL_BORDERS }),
        ],
      }),
      new TableRow({
        children: [
          cell('________________   ' + sigName, { widthDxa: 7700, size: 16, borders: NO_CELL_BORDERS }),
          cell('________________   _____________', { widthDxa: 7700, size: 16, borders: NO_CELL_BORDERS }),
        ],
      }),
      new TableRow({
        children: [
          cell('(подпись)            (Ф.И.О.)', { widthDxa: 7700, size: 12, align: AlignmentType.LEFT, borders: NO_CELL_BORDERS }),
          cell('(подпись)            (Ф.И.О.)', { widthDxa: 7700, size: 12, align: AlignmentType.LEFT, borders: NO_CELL_BORDERS }),
        ],
      }),
    ],
  });

  // Block 2: Двухстолбцовый передаточный блок (передал | получил)
  const transferRow = new Table({
    width: { size: LANDSCAPE_USABLE_DXA, type: WidthType.DXA },
    columnWidths: [7700, 7700],
    layout: TableLayoutType.FIXED,
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER, insideHorizontal: NO_BORDER, insideVertical: BORDER_THIN },
    rows: [
      new TableRow({
        children: [
          cell([
            'Основание передачи (сдачи) / получения (приёмки) (10): __________________________',
            '(договор; доверенность и др.)',
            '',
            'Данные о транспортировке и грузе (11): __________________________',
            '',
            'Товар (груз) передал / услуги, результаты работ, права сдал (12):',
            '_________________   _________________   _________________',
            '(должность)             (подпись)              (Ф.И.О.)',
            '',
            'Дата отгрузки, передачи (сдачи) (13): _____________________',
            '',
            'Иные сведения об отгрузке, передаче (14): _____________________',
            '(ссылки на неотъемлемые приложения, сопутствующие документы)',
            '',
            'Ответственный за правильность оформления факта хозяйственной жизни (15):',
            '_________________   _________________   _________________',
            '(должность)             (подпись)              (Ф.И.О.)',
            '',
            'Наименование экономического субъекта — составителя документа (16): _____________________',
            '',
            'М.П.',
          ], { widthDxa: 7700, size: 14, borders: NO_CELL_BORDERS }),
          cell([
            '',
            '',
            '',
            '',
            '',
            'Товар (груз) получил / услуги, результаты работ, права принял (17):',
            '_________________   _________________   _________________',
            '(должность)             (подпись)              (Ф.И.О.)',
            '',
            'Дата получения (приёмки) (18): _____________________',
            '',
            'Иные сведения о получении, приёмке (19): _____________________',
            '(информация о наличии/отсутствии претензий)',
            '',
            'Ответственный за правильность оформления факта хозяйственной жизни (20):',
            '_________________   _________________   _________________',
            '(должность)             (подпись)              (Ф.И.О.)',
            '',
            'Наименование экономического субъекта — составителя документа (21): _____________________',
            '',
            'М.П.',
          ], { widthDxa: 7700, size: 14, borders: NO_CELL_BORDERS }),
        ],
      }),
    ],
  });

  return [
    para('Документ составлен на ___ листах', { size: 14, spaceAfter: 120 }),
    directorRow,
    para('', { spaceAfter: 120 }),
    transferRow,
  ];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function renderUpd(input: RenderUpdInput): Promise<Uint8Array> {
  const status: 1 | 2 = input.status ?? 1;

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `UPD ${input.reference}`,
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 16 } },
      },
    },
    sections: [{
      properties: { page: LANDSCAPE_PAGE },
      children: [
        appendixReference(),
        ...titleBlock(status),
        buildHeader(input),
        blank(),
        buildMainTable(input),
        blank(),
        ...buildSignaturesAndFooter(input),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
