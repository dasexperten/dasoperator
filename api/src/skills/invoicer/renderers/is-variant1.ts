// =============================================================================
// IS-V1 — Brushes (Yangzhou Jinxia format).
// Bilingual EN+RU. Three-party block (Shipper / Buyer / Seller). Used for
// toothbrushes leaving China to Russia (HS 9603xxx).
// =============================================================================

import { AlignmentType, Document, Packer } from 'docx';
import type { ContractRow, LineItemRow } from '../types';
import {
  RenderBank, RenderParty, RenderSignature, bankBlock, bilingual, blank,
  buildTable, formatDate, formatMoney, heading, p, partyBlock, signatureBlock,
} from './shared';

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
  const cols = [
    { header: '#', widthPct: 4 },
    { header: 'HS Code', widthPct: 11 },
    { header: bilingual('Origin', 'Страна'), widthPct: 9 },
    { header: bilingual('Description', 'Описание'), widthPct: 30 },
    { header: bilingual('Qty (pcs)', 'Кол-во (шт)'), widthPct: 8 },
    { header: bilingual('Cartons', 'Кор-ов'), widthPct: 8 },
    { header: bilingual('Net (kg)', 'Нетто'), widthPct: 8 },
    { header: bilingual('Gross (kg)', 'Брутто'), widthPct: 8 },
    { header: bilingual('Price', 'Цена'), widthPct: 7 },
    { header: bilingual('Amount', 'Сумма'), widthPct: 7 },
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
      properties: {},
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
        buildTable(cols, rows),
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
