// =============================================================================
// IS-V1 — Brushes (Yangzhou Jinxia format).
// Bilingual EN+RU. Three-party block (Shipper / Buyer / Seller). Used for
// toothbrushes leaving China to Russia (HS 9603xxx).
// =============================================================================

import { AlignmentType, Document, Packer, PageOrientation } from 'docx';
import type { ContractRow, LineItemRow } from '../types';
import {
  RenderBank, RenderParty, RenderSignature, bankBlock, bilingual, blank,
  buildTableDxa, formatDate, formatMoney, heading, p, partyBlock, signatureBlock,
} from './shared';

// A4 landscape — width / height are in DXA (twentieths of a point).
// 16838 = 842pt = 297mm; 11906 = 595pt = 210mm. 720 DXA = 0.5 inch margin.
const PAGE_LANDSCAPE = {
  size: {
    orientation: PageOrientation.LANDSCAPE,
    width: 16838,
    height: 11906,
  },
  margin: { top: 720, right: 720, bottom: 720, left: 720 },
} as const;

export interface RenderIsV1Input {
  reference: string;
  issuedAt: number;
  currency: string;
  shipper: RenderParty;       // manufacturer (Jinxia)
  buyer: RenderParty;         // ultimate consignee (DEE or recipient)
  seller: RenderParty;        // selling-side party (DEI for layered, manufacturer otherwise)
  bank: RenderBank | null;
  signature: RenderSignature;
  contract: ContractRow | null;
  incoterms: string;
  consigneeAtTerminal: string | null;
  lineItems: LineItemRow[];
  totalMinor: number;
}

export async function renderInvoiceSpecBrushes(input: RenderIsV1Input): Promise<Uint8Array> {
  // DXA widths balanced for A4 landscape with 720 DXA margins (15398 DXA usable).
  // Description is the widest column — bilingual product names need the room.
  const cols = [
    { header: '#', widthDxa: 500 },
    { header: 'HS Code', widthDxa: 1300 },
    { header: bilingual('Origin', 'Страна'), widthDxa: 1300 },
    { header: bilingual('Description', 'Описание'), widthDxa: 5000 },
    { header: bilingual('Qty (pcs)', 'Кол-во (шт)'), widthDxa: 1100 },
    { header: bilingual('Cartons', 'Кор-ов'), widthDxa: 900 },
    { header: bilingual('Net (kg)', 'Нетто'), widthDxa: 1100 },
    { header: bilingual('Gross (kg)', 'Брутто'), widthDxa: 1100 },
    { header: bilingual('Price', 'Цена'), widthDxa: 1100 },
    { header: bilingual('Amount', 'Сумма'), widthDxa: 2000 },
  ];

  const rows: string[][] = input.lineItems.map((li, idx) => {
    const desc = bilingual(
      li.description_en ?? li.invoice_label ?? li.product_id,
      li.description_ru,
    );
    const qtyPerCtn = li.ctn_qty ?? 0;
    const cartons = li.cartons > 0
      ? li.cartons
      : (qtyPerCtn > 0 ? Math.ceil(li.qty / qtyPerCtn) : 0);
    const net = li.unit_net_weight_g !== null
      ? ((li.qty * li.unit_net_weight_g) / 1000).toFixed(3)
      : 'TBD';
    const gross = (li.ctn_weight_gross_kg !== null && cartons > 0)
      ? (cartons * li.ctn_weight_gross_kg).toFixed(3)
      : 'TBD';
    return [
      String(idx + 1),
      li.hs_code ?? 'TBD',
      bilingual(li.country_of_origin ?? 'China', 'Китай'),
      desc,
      String(li.qty),
      String(cartons),
      net,
      gross,
      formatMoney(li.unit_price_after_disc, input.currency),
      formatMoney(li.line_amount, input.currency),
    ];
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `IS-V1 ${input.reference}`,
    sections: [{
      properties: { page: PAGE_LANDSCAPE },
      children: [
        heading('INVOICE-SPECIFICATION / СЧЁТ-СПЕЦИФИКАЦИЯ'),
        blank(),
        p(`${bilingual('Invoice No.', 'Инвойс №')}: ${input.reference}`, { bold: true }),
        p(`${bilingual('Date', 'Дата')}: ${formatDate(input.issuedAt)}`),
        ...(input.contract
          ? [p(`${bilingual('Contract', 'Договор')}: ${input.contract.contract_no}`)] : []),
        ...(input.contract?.unk_reference
          ? [p(`УНК: ${input.contract.unk_reference}`)] : []),
        ...(input.consigneeAtTerminal
          ? [p(`${bilingual('Consignee at terminal', 'Получатель по ст.')}: ${input.consigneeAtTerminal}`)] : []),
        blank(),
        ...partyBlock({ language: 'BILINGUAL', label: bilingual('SHIPPER', 'ОТПРАВИТЕЛЬ'), party: input.shipper }),
        blank(),
        ...partyBlock({ language: 'BILINGUAL', label: bilingual('BUYER', 'ПОКУПАТЕЛЬ'), party: input.buyer }),
        blank(),
        ...partyBlock({ language: 'BILINGUAL', label: bilingual('SELLER', 'ПРОДАВЕЦ'), party: input.seller }),
        blank(),
        p(`${bilingual('Terms of delivery', 'Условия поставки')}: ${input.incoterms}`, { bold: true }),
        ...(input.bank ? [blank(), ...bankBlock(input.bank, 'BILINGUAL')] : []),
        blank(),
        buildTableDxa(cols, rows),
        blank(),
        p(`${bilingual('TOTAL', 'ИТОГО')}: ${formatMoney(input.totalMinor, input.currency)}`,
          { bold: true, size: 24 }, AlignmentType.RIGHT),
        blank(),
        ...signatureBlock(input.signature, 'BILINGUAL'),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}
