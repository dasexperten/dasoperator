// =============================================================================
// PL — Packing List. Portrait A4. Any RenderLanguage. No money, no signature
// beyond a short shipper-signature line.
// =============================================================================

import type { DocumentLanguage, LineItemRow } from '../types';
import {
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderParty, blank,
  buildDeliveryBankTable, buildMetaRow, buildPartyTable, buildProductTable,
  buildTitle, formatDate, p, pickLineLabel,
  t, tBilingual, type RenderLanguage,
  type ProductCell,
} from './shared';
import { AlignmentType } from 'docx';

export interface RenderPlInput {
  reference: string;
  issuedAt: number;
  language: DocumentLanguage;
  issuerLanguage?: RenderLanguage;
  partnerLanguage?: RenderLanguage;
  shipper: RenderParty;
  consignee: RenderParty;
  ciReference: string | null;
  lineItems: LineItemRow[];
}

function resolveTranslator(input: RenderPlInput): {
  primary: RenderLanguage;
  translate: (key: string) => string;
} {
  if (input.language === 'BILINGUAL') {
    const issuer = input.issuerLanguage ?? 'EN';
    const partner = input.partnerLanguage ?? issuer;
    return { primary: issuer, translate: (key) => tBilingual(key, issuer, partner) };
  }
  const lang = input.language as RenderLanguage;
  return { primary: lang, translate: (key) => t(key, lang) };
}

export async function renderPackingList(input: RenderPlInput): Promise<Uint8Array> {
  const { primary, translate } = resolveTranslator(input);
  const lineLabelLang: 'RU' | 'EN' | null =
    primary === 'RU' ? 'RU' : primary === 'EN' ? 'EN' : null;

  const partyTableLang: 'EN' | 'RU' | 'BILINGUAL' =
    input.language === 'BILINGUAL' ? 'BILINGUAL' :
    primary === 'RU' ? 'RU' : 'EN';

  const meta = [
    { label: translate('meta.number_short'), value: input.reference },
    { label: translate('meta.date'), value: formatDate(input.issuedAt) },
  ];
  if (input.ciReference) {
    meta.push({ label: translate('meta.related_ci'), value: input.ciReference });
  }

  const partyTable = buildPartyTable({
    language: partyTableLang,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    shipperLabel: translate('party.shipper'),
    shipper: input.shipper,
    consigneeLabel: translate('party.consignee'),
    consignee: input.consignee,
  });

  let totalCartons = 0, totalQty = 0, totalNet = 0, totalGross = 0, allWeightsKnown = true;

  const rows: ProductCell[][] = input.lineItems.map((li, idx) => {
    const desc = pickLineLabel(li, { kind: 'PL', partnerLang: lineLabelLang });
    const qtyPerCtn = li.ctn_qty ?? 0;
    const cartons = li.cartons > 0 ? li.cartons : (qtyPerCtn > 0 ? Math.ceil(li.qty / qtyPerCtn) : 0);
    const lineNetKg = li.unit_net_weight_g !== null ? (li.qty * li.unit_net_weight_g) / 1000 : null;
    const lineGrossKg = (li.ctn_weight_gross_kg !== null && cartons > 0) ? cartons * li.ctn_weight_gross_kg : null;
    if (lineNetKg !== null) totalNet += lineNetKg; else allWeightsKnown = false;
    if (lineGrossKg !== null) totalGross += lineGrossKg; else allWeightsKnown = false;
    totalCartons += cartons;
    totalQty += li.qty;
    return [
      { text: String(idx + 1), align: 'center' },
      { text: li.product_id, align: 'left' },
      { text: desc, align: 'left' },
      { text: String(qtyPerCtn || ''), align: 'right' },
      { text: String(li.qty), align: 'right' },
      { text: String(cartons), align: 'right' },
      { text: lineNetKg !== null ? lineNetKg.toFixed(3) : 'TBD', align: 'right' },
      { text: lineGrossKg !== null ? lineGrossKg.toFixed(3) : 'TBD', align: 'right' },
    ];
  });

  const summaryLines: string[] = [
    `${translate('summary.cartons')}: ${totalCartons}`,
    `${translate('summary.qty')}: ${totalQty}`,
  ];
  if (allWeightsKnown) {
    summaryLines.push(`${translate('summary.net')}: ${totalNet.toFixed(3)}`);
    summaryLines.push(`${translate('summary.gross')}: ${totalGross.toFixed(3)}`);
  } else {
    summaryLines.push(`${translate('summary.weights_tbd')}: TBD`);
  }

  const summaryTable = buildDeliveryBankTable({
    language: partyTableLang,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    deliveryHeader: translate('section.shipment'),
    deliveryLines: [`${translate('summary.for_invoice')}: ${input.ciReference ?? '—'}`],
    rightHeader: translate('section.summary'),
    rightLines: summaryLines,
  });

  const widths = [350, 800, 3500, 900, 900, 800, 1000, 2250];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'SKU', align: 'left' as const },
    { text: translate('col.description'), align: 'left' as const },
    { text: translate('col.qty_per_ctn'), align: 'right' as const },
    { text: translate('col.qty_total'), align: 'right' as const },
    { text: translate('col.cartons'), align: 'right' as const },
    { text: translate('col.net_kg'), align: 'right' as const },
    { text: translate('col.gross_kg'), align: 'right' as const },
  ];

  const productTable = buildProductTable({
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    widths, headers, rows,
    totalLabel: translate('total.label'),
    totalLabelSpan: 4,
    totalValues: [
      { text: String(totalQty), align: 'right' },
      { text: String(totalCartons), align: 'right' },
      { text: allWeightsKnown ? totalNet.toFixed(3) : 'TBD', align: 'right' },
      { text: allWeightsKnown ? totalGross.toFixed(3) : 'TBD', align: 'right' },
    ],
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `Packing List ${input.reference}`,
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        buildTitle(translate('title.packing_list')),
        buildMetaRow(meta),
        partyTable,
        blank(),
        summaryTable,
        blank(),
        productTable,
        blank(),
        p(translate('sig.shipper'),
          { bold: true, size: 18, align: AlignmentType.RIGHT, spaceBefore: 200 }),
        p('_______________________', { align: AlignmentType.RIGHT, size: 16 }),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
