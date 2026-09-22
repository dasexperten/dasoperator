// =============================================================================
// PL — Packing List. Portrait A4. Any RenderLanguage. No money, no signature
// beyond a short shipper-signature line.
// =============================================================================

import type { DocumentLanguage, LineItemRow, PackingDetails } from '../types';
import {
  Document, Packer, PORTRAIT_PAGE, PORTRAIT_USABLE_DXA, RenderParty, RenderSignature, blank,
  buildBrandBar, buildDeliveryBankTable, buildMetaRow, buildPartyTable, buildProductTable,
  buildPartyLineBlock, buildSignature, buildTitle, formatDate, p, pickLineLabel,
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
  physicalShipperLine: string | null;
  consignee: RenderParty;
  signature: RenderSignature;
  ciReference: string | null;
  incoterms: string;
  shipmentDetails?: string[];
  packingDetails?: PackingDetails;
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
    shipperLabel: translate('party.seller'),
    shipper: input.shipper,
    consigneeLabel: translate('party.consignee'),
    consignee: input.consignee,
  });

  const physicalShipperBlock = input.physicalShipperLine
    ? buildPartyLineBlock({
        totalWidthDxa: PORTRAIT_USABLE_DXA,
        label: translate('party.shipper'),
        lines: [input.physicalShipperLine],
      })
    : null;

  let totalCartons = 0, totalQty = 0, totalNet = 0, totalVolume = 0, totalGross = 0;
  let allNetKnown = true, allVolumeKnown = true, allGrossKnown = true;

  const order = new Map((input.packingDetails?.line_order ?? []).map((id, index) => [id, index]));
  const orderedLineItems = [...input.lineItems].sort((a, b) =>
    (order.get(a.product_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.product_id) ?? Number.MAX_SAFE_INTEGER));
  const rows: ProductCell[][] = orderedLineItems.map((li, idx) => {
    const desc = pickLineLabel(li, { kind: 'PL', partnerLang: lineLabelLang });
    const override = input.packingDetails?.lines?.[li.product_id];
    const qtyPerCtn = override?.qty_per_carton ?? li.ctn_qty ?? 0;
    const cartons = override?.cartons ?? (li.cartons > 0 ? li.cartons : (qtyPerCtn > 0 ? Math.ceil(li.qty / qtyPerCtn) : 0));
    const lineNetKg = override?.net_weight_kg
      ?? (li.unit_net_weight_g !== null ? (li.qty * li.unit_net_weight_g) / 1000 : null);
    const lineVolume = override?.volume_cbm ?? null;
    const lineGrossKg = override?.gross_weight_kg
      ?? ((li.ctn_weight_gross_kg !== null && cartons > 0) ? cartons * li.ctn_weight_gross_kg : null);
    if (lineNetKg !== null) totalNet += lineNetKg; else allNetKnown = false;
    if (lineVolume !== null) totalVolume += lineVolume; else allVolumeKnown = false;
    if (lineGrossKg !== null) totalGross += lineGrossKg; else allGrossKnown = false;
    totalCartons += cartons;
    totalQty += li.qty;
    return [
      { text: String(idx + 1), align: 'center' },
      { text: li.product_id, align: 'left' },
      { text: desc, align: 'left' },
      { text: String(qtyPerCtn || ''), align: 'right' },
      { text: String(li.qty), align: 'right' },
      { text: String(cartons), align: 'right' },
      { text: lineNetKg !== null ? (override?.net_weight_kg !== undefined ? String(lineNetKg) : lineNetKg.toFixed(3)) : 'TBD', align: 'right' },
      { text: lineVolume !== null ? String(lineVolume) : 'TBD', align: 'right' },
      { text: lineGrossKg !== null ? (override?.gross_weight_kg !== undefined ? String(lineGrossKg) : lineGrossKg.toFixed(3)) : 'TBD', align: 'right' },
    ];
  });

  const totals = input.packingDetails?.totals;
  const displayQty = totals?.qty ?? totalQty;
  const displayCartons = totals?.cartons ?? totalCartons;
  const displayNet = totals?.net_weight_kg ?? (allNetKnown ? totalNet : null);
  const displayVolume = totals?.volume_cbm ?? (allVolumeKnown ? totalVolume : null);
  const displayGross = totals?.gross_weight_kg ?? (allGrossKnown ? totalGross : null);

  const summaryLines: string[] = [
    `${translate('summary.cartons')}: ${displayCartons}`,
    `${translate('summary.qty')}: ${displayQty}`,
  ];
  summaryLines.push(`${translate('summary.net')}: ${displayNet !== null ? String(displayNet) : 'TBD'}`);
  summaryLines.push(`Volume (CBM): ${displayVolume !== null ? String(displayVolume) : 'TBD'}`);
  summaryLines.push(`${translate('summary.gross')}: ${displayGross !== null ? String(displayGross) : 'TBD'}`);

  const summaryTable = buildDeliveryBankTable({
    language: partyTableLang,
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    deliveryHeader: translate('section.shipment'),
    deliveryLines: [
      `${translate('misc.terms')}: ${input.incoterms}`,
      `${translate('summary.for_invoice')}: ${input.ciReference ?? '—'}`,
      ...(input.packingDetails?.package_description
        ? [`Packing: ${input.packingDetails.package_description}`]
        : []),
      ...(input.shipmentDetails ?? []),
    ],
    rightHeader: translate('section.summary'),
    rightLines: summaryLines,
  });

  const widths = [300, 700, 4150, 800, 800, 750, 900, 900, 1200];
  const headers = [
    { text: '#', align: 'center' as const },
    { text: 'SKU', align: 'left' as const },
    { text: translate('col.description'), align: 'left' as const },
    { text: translate('col.qty_per_ctn'), align: 'right' as const },
    { text: translate('col.qty_total'), align: 'right' as const },
    { text: translate('col.cartons'), align: 'right' as const },
    { text: translate('col.net_kg'), align: 'right' as const },
    { text: 'CBM', align: 'right' as const },
    { text: translate('col.gross_kg'), align: 'right' as const },
  ];

  const productTable = buildProductTable({
    totalWidthDxa: PORTRAIT_USABLE_DXA,
    widths, headers, rows,
    totalLabel: translate('total.label'),
    totalLabelSpan: 4,
    totalValues: [
      { text: String(displayQty), align: 'right' },
      { text: String(displayCartons), align: 'right' },
      { text: displayNet !== null ? String(displayNet) : 'TBD', align: 'right' },
      { text: displayVolume !== null ? String(displayVolume) : 'TBD', align: 'right' },
      { text: displayGross !== null ? String(displayGross) : 'TBD', align: 'right' },
    ],
  });

  const doc = new Document({
    creator: 'dasoperator-api',
    title: `Packing List ${input.reference}`,
    sections: [{
      properties: { page: PORTRAIT_PAGE },
      children: [
        buildTitle(translate('title.packing_list')),
        buildBrandBar(),
        buildMetaRow(meta),
        partyTable,
        ...(physicalShipperBlock ? [blank(), physicalShipperBlock] : []),
        blank(),
        summaryTable,
        blank(),
        productTable,
        blank(),
        p(translate('sig.shipper'),
          { bold: true, size: 18, align: AlignmentType.RIGHT, spaceBefore: 200 }),
        ...buildSignature(input.signature, input.language),
      ],
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
